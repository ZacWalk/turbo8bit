//
// @fileoverview SID Player - Entry point for SID music playback in Turbo8bit
// @module emulator/sid-player
//
// This is the main entry point for SID music file playback. Import this module
// in sid.html or any page that needs to play SID files.
//
// Provides:
// - PSID/RSID file format parsing (parseSidFile)
// - SID tune loading into C64Machine (loadSidTune)
// - Clock frequency constants (CLOCK_PAL, CLOCK_NTSC)
// - SIDPlayer class for browser-based playback with Web Audio API
//
// Browser Usage (sid.html):
//   <script type="module" src="/static/js/emulator/sid-player.js"></script>
//   <!-- SIDPlayer is automatically available as window.SIDPlayer -->
//
// ES6 Module Usage:
//   import { SIDPlayer, parseSidFile, CLOCK_PAL } from './sid-player.js';
//
//   const player = new SIDPlayer();
//   await player.load('song.sid');
//   await player.play();
//
// For visual C64 emulation with screen/keyboard, see emulator.js.
// For SID chip emulation details, see sid.js.
// For PSID driver installation, see psid-driver.js.
//
// @see https://www.turbo8bit.com/
//

import { ChipModel, SamplingMethod } from './sid.js';
import { C64Machine, CLOCK_PAL, CLOCK_NTSC } from './machine.js';
import { generatePsidDriver } from './psid-driver.js';

// Re-export clock constants from machine.js for backward compatibility
// (Consumers should import from machine.js directly)
export { CLOCK_PAL, CLOCK_NTSC };

// ============================================================================
// PSID/RSID FILE PARSING
// ============================================================================

// PSID file format constants
const PSID_MAGIC = 0x50534944; // "PSID"
const RSID_MAGIC = 0x52534944; // "RSID"

//
// Parse a SID file and extract metadata and data
//
// Supports single-SID PSID v1-v4 and machine-code RSID v2-v4.
// MUS, PlaySID-specific, BASIC, and multi-SID tunes are rejected explicitly.
//
// @param {ArrayBuffer} buffer - The raw SID file data
// @returns {Object} Parsed SID file info including:
//   - magic: 'PSID' or 'RSID'
//   - version: File format version (1-4)
//   - isRSID: True if this is an RSID file (requires full C64 emulation)
//   - loadAddress: Where to load the tune data in C64 memory
//   - initAddress: Address of the init routine
//   - playAddress: Address of the play routine (0 for RSID = use IRQ)
//   - songs: Number of subtunes
//   - startSong: Default subtune (1-based)
//   - speed: Bit field indicating timing (CIA vs VIC) per subtune
//   - name: Tune name
//   - author: Author name
//   - released: Copyright/release info
//   - clock: CLOCK_PAL or CLOCK_NTSC
//   - model: ChipModel.MOS6581 or ChipModel.MOS8580
//   - data: Uint8Array of the tune program data
// @throws {Error} If the file is not a valid PSID/RSID file
//
export function parseSidFile(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) {
        throw new Error('SID file is too short to contain a header');
    }
    const data = new Uint8Array(buffer);
    const view = new DataView(buffer);

    // Check magic
    const magic = view.getUint32(0, false);
    if (magic !== PSID_MAGIC && magic !== RSID_MAGIC) {
        throw new Error('Not a valid PSID/RSID file');
    }

    const isRSID = magic === RSID_MAGIC;
    const version = view.getUint16(4, false);
    if (version < (isRSID ? 2 : 1) || version > 4) {
        throw new Error(`Unsupported ${isRSID ? 'RSID' : 'PSID'} version: ${version}`);
    }
    const headerSize = version === 1 ? 0x76 : 0x7c;
    if (buffer.byteLength < headerSize) {
        throw new Error('SID file has a truncated header');
    }
    const dataOffset = view.getUint16(6, false);
    if (dataOffset < headerSize || dataOffset >= buffer.byteLength) {
        throw new Error(`Invalid PSID/RSID dataOffset: ${dataOffset}`);
    }
    const loadAddress = view.getUint16(8, false);
    const initAddress = view.getUint16(10, false);
    const playAddress = view.getUint16(12, false);
    const songs = view.getUint16(14, false);
    const startSong = view.getUint16(16, false);
    const speed = view.getUint32(18, false);
    if (songs < 1 || songs > 256 || startSong < 1 || startSong > songs) {
        throw new Error('Invalid SID song count or starting song');
    }
    if (isRSID && (loadAddress !== 0 || playAddress !== 0 || speed !== 0)) {
        throw new Error('RSID requires an embedded load address, zero play address, and zero speed');
    }

    // Read strings (null-terminated, 32 bytes each)
    const decoder = new TextDecoder('iso-8859-1');
    const name = decoder.decode(data.subarray(22, 54)).replace(/\0.*$/, '');
    const author = decoder.decode(data.subarray(54, 86)).replace(/\0.*$/, '');
    const released = decoder.decode(data.subarray(86, 118)).replace(/\0.*$/, '');

    // Version 2+ fields
    let flags = 0;
    let startPage = 0;
    let pageLength = 0;
    let secondSIDAddress = 0;
    let thirdSIDAddress = 0;

    if (version >= 2) {
        flags = view.getUint16(118, false);
        startPage = data[120];
        pageLength = data[121];
        secondSIDAddress = data[122];
        thirdSIDAddress = data[123];
    }
    if (flags & 1) {
        throw new Error('MUS-format SID tunes are not supported');
    }
    if (flags & 2) {
        throw new Error(isRSID ? 'BASIC RSID tunes are not supported' :
            'PlaySID-specific tunes are not supported');
    }
    const allowedFlags = version >= 4 ? 0x3ff : version >= 3 ? 0xff : 0x3f;
    if (flags & ~allowedFlags) {
        throw new Error('SID header contains reserved flags');
    }
    if (secondSIDAddress || thirdSIDAddress) {
        throw new Error('Multiple SID chips are not supported');
    }
    if (((startPage === 0 || startPage === 0xff) && pageLength !== 0) ||
        (startPage !== 0 && startPage !== 0xff &&
            (pageLength === 0 || startPage + pageLength > 0x100))) {
        throw new Error('Invalid SID driver relocation range');
    }

    // Extract program data
    let programData = data.subarray(dataOffset);
    let actualLoadAddress = loadAddress;

    // If load address is 0, first two bytes are the actual load address
    if (loadAddress === 0) {
        if (programData.length < 2) {
            throw new Error('PSID/RSID data too short for embedded load address');
        }
        actualLoadAddress = programData[0] | (programData[1] << 8);
        programData = programData.subarray(2);
    }
    if (programData.length === 0 || actualLoadAddress + programData.length > 0x10000) {
        throw new Error('SID program is empty or exceeds C64 memory');
    }
    if (isRSID && (actualLoadAddress < 0x07e8 || initAddress < 0x07e8 ||
        (initAddress >= 0xa000 && initAddress < 0xc000) || initAddress >= 0xd000)) {
        throw new Error('RSID load and init addresses must use supported C64 RAM');
    }

    // Determine clock and model from flags
    const clockFlag = (flags >> 2) & 0x03;
    const modelFlag = (flags >> 4) & 0x03;

    let clock = CLOCK_PAL;
    if (clockFlag === 2) clock = CLOCK_NTSC;

    let model = ChipModel.MOS6581;
    if (modelFlag === 2) model = ChipModel.MOS8580;

    return {
        magic: magic === PSID_MAGIC ? 'PSID' : 'RSID',
        version,
        isRSID,
        loadAddress: actualLoadAddress,
        initAddress: initAddress || actualLoadAddress,
        playAddress,
        songs,
        startSong,
        speed,
        name,
        author,
        released,
        clock,
        model,
        flags,
        startPage,
        pageLength,
        secondSIDAddress,
        thirdSIDAddress,
        data: programData
    };
}

//
// Install a PSID driver into a C64 machine
//
// @param {C64Machine} machine - The C64 machine instance
// @param {Object} driver - Validated driver and memory layout
// @private
//
function installDriver(machine, driver) {
    // Install all memory regions
    for (const region of driver.regions) {
        machine.loadCode(region.data, region.address);
    }

    // Set memory configuration
    machine.write(0x0001, driver.ioPort);

    // Set CPU state
    machine.cpu.PC = driver.cpuState.PC;
    machine.cpu.A = driver.cpuState.A;
    machine.cpu.X = driver.cpuState.X;
    machine.cpu.Y = driver.cpuState.Y;
    machine.cpu.SP = driver.cpuState.SP;
    machine.cpu.P = driver.cpuState.P;
    machine.cpu.halted = false;
}

function configureSidTune(machine, tune, driver) {
    machine.reset();
    if (tune.clock !== machine.clockFrequency) {
        machine.clockFrequency = tune.clock;
        machine.cyclesPerFrame = machine.rasterTiming.cyclesPerFrame;
    }
    machine.sid.setSamplingParameters(machine.clockFrequency, SamplingMethod.DECIMATE, machine.sampleRate);
    machine.sid.setChipModel(tune.model);
    machine.loadCode(tune.data, tune.loadAddress);
    installDriver(machine, driver);
}

//
// Load a SID tune into a C64Machine and set up playback
//
// This uses the full C64 emulation with a minimal PSID driver,
//
// @param {C64Machine} machine - The C64 machine instance
// @param {ArrayBuffer} buffer - The SID file data
// @param {number} song - The subtune to play (1-based, default is startSong from file)
// @returns {Object} The parsed SID tune info
//
export function loadSidTune(machine, buffer, song = null) {
    const tune = parseSidFile(buffer);
    const songNumber = song !== null ? song : tune.startSong;
    if (!Number.isInteger(songNumber) || songNumber < 1 || songNumber > tune.songs) {
        throw new RangeError('SID song number is out of range');
    }
    // Complete validation and placement before touching the existing machine.
    const driver = generatePsidDriver(tune, songNumber - 1);
    configureSidTune(machine, tune, driver);
    return tune;
}

// ============================================================================
// AUDIO WORKLET PROCESSOR
// ============================================================================

//
// AudioWorklet processor code for SID playback (inline for portability)
// This runs in a separate thread for low-latency audio processing.
// @private
//
const sidWorkletProcessorCode = `
class SIDWorkletProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.sampleQueue = [];
        this.currentBuffer = null;
        this.bufferIndex = 0;
        this.pendingRequest = false;

        this.port.onmessage = (event) => {
            if (event.data.type === 'samples') {
                this.sampleQueue.push(new Float32Array(event.data.buffer));
                this.pendingRequest = false;
                if (this.sampleQueue.length > 2) this.sampleQueue.shift();
            }
        };
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0][0];
        let outputIndex = 0;

        while (outputIndex < output.length) {
            if (!this.currentBuffer || this.bufferIndex >= this.currentBuffer.length) {
                if (this.sampleQueue.length > 0) {
                    this.currentBuffer = this.sampleQueue.shift();
                    this.bufferIndex = 0;
                } else {
                    for (let i = outputIndex; i < output.length; i++) output[i] = 0;
                    if (!this.pendingRequest) {
                        this.pendingRequest = true;
                        this.port.postMessage({ type: 'needSamples' });
                    }
                    return true;
                }
            }

            const toCopy = Math.min(this.currentBuffer.length - this.bufferIndex, output.length - outputIndex);
            for (let i = 0; i < toCopy; i++) {
                output[outputIndex++] = this.currentBuffer[this.bufferIndex++];
            }
        }

        if (this.sampleQueue.length < 2 && !this.pendingRequest) {
            this.pendingRequest = true;
            this.port.postMessage({ type: 'needSamples' });
        }
        return true;
    }
}
registerProcessor('sid-worklet-processor', SIDWorkletProcessor);
`;

// ============================================================================
// WEB SID PLAYER
// ============================================================================

function playbackCancelled() {
    const error = new Error('SID playback operation was cancelled');
    error.name = 'AbortError';
    return error;
}

function renderSidFrame(machine, buffer) {
    machine.runFrame(buffer);
    if (machine.cpu?.halted) {
        throw new Error('SID program halted the C64 CPU');
    }
    const count = machine.audioSamplesGenerated;
    if (!Number.isInteger(count) || count <= 0 || count > buffer.length) {
        throw new Error('SID frame produced an invalid audio sample count');
    }
    return count;
}

//
// SIDPlayer - SID music player using full C64 emulation
//
// This class provides browser-based SID playback with:
// - SID file loading and playback via C64Machine
// - Web Audio API output (AudioWorklet with ScriptProcessor fallback)
// - Visualization state for UI (voice info, registers, envelope)
// - API compatible with the previous SIDPlayer for easy migration
//
// @example
// const player = new SIDPlayer();
// await player.load('/static/sid/Last_Ninja.sid');
// await player.play();
//
// // Get visualization state
// const state = player.getState();
// console.log(state.voices[0].waveform); // e.g., 'PULSE'
//
export class SIDPlayer {
    constructor() {
        this.sampleRate = 44100;
        this.sidFile = null;
        this.currentSong = 0;
        this.isPlaying = false;

        // Audio nodes
        this.audioContext = null;
        this.scriptNode = null;
        this.workletNode = null;
        this.useWorklet = false;

        // Buffer for worklet
        this.workletBufferSize = 4096;
        this.workletSamples = null;
        this._workletModulePromise = null;
        this._loadGeneration = 0;
        this._playGeneration = 0;
        this._playPromise = null;
        this._cancelStart = null;

        // C64 machine for emulation
        this.machine = null;

        // One frame is the entire FIFO: callbacks consume it before producing another.
        this._frameCount = 0;
        this.samplesPerFrame = 0;
        this._frameBuffer = new Int16Array(Math.ceil(this.sampleRate / 50) + 32);
        this._frameReadIndex = 0;
        this._frameSampleCount = 0;

        // Callback for UI updates
        this.onFrameUpdate = null;

        // Register snapshot for visualization
        this.registers = new Uint8Array(32);
        this.registerWriteLog = [];
    }

    //
    // Load a SID file from URL
    // Only the latest selection may commit; superseded loads reject with AbortError.
    // @param {string} url - URL to the SID file
    // @returns {Promise<Object>} Parsed SID file info
    //
    async load(url) {
        const generation = ++this._loadGeneration;
        let buffer;
        try {
            const response = await fetch(url);
            if (generation !== this._loadGeneration) throw playbackCancelled();
            if (!response.ok) {
                throw new Error(`Failed to load: ${response.statusText}`);
            }
            buffer = await response.arrayBuffer();
        } catch (error) {
            if (generation !== this._loadGeneration) throw playbackCancelled();
            throw error;
        }
        if (generation !== this._loadGeneration) throw playbackCancelled();
        return this.loadData(buffer);
    }

    //
    // Load SID file from ArrayBuffer
    // @param {ArrayBuffer} buffer - Raw SID file data
    // Successful selections leave playback stopped; failed selections preserve it.
    // @returns {Object} Parsed SID file info
    //
    loadData(buffer) {
        ++this._loadGeneration;
        const tune = parseSidFile(buffer);
        const playback = this.preparePlayback(tune, tune.startSong - 1, 10);
        return this.commitPlayback(playback);
    }

    preparePlayback(tune, song, initFrames, previousMachine = null) {
        const configuration = previousMachine ? {
            ...tune,
            clock: previousMachine.clockFrequency,
            model: previousMachine.sid.getChipModel()
        } : tune;
        const driver = generatePsidDriver(configuration, song);
        const machine = new C64Machine({ sampleRate: this.sampleRate, audioEnabled: true });
        const registers = new Uint8Array(32);
        const registerWriteLog = [];
        const frameBuffer = new Int16Array(Math.ceil(this.sampleRate / 50) + 32);
        configureSidTune(machine, configuration, driver);
        if (previousMachine) machine.cyclesPerFrame = previousMachine.cyclesPerFrame;
        this.setupSIDInterception(machine, registers, registerWriteLog);
        this.runInitFrames(initFrames, machine, frameBuffer);
        return { machine, tune, song, registers, registerWriteLog, frameBuffer };
    }

    commitPlayback(playback) {
        this.stop();
        this.machine = playback.machine;
        this.sidFile = playback.tune;
        this.currentSong = playback.song;
        this.registers = playback.registers;
        this.registerWriteLog = playback.registerWriteLog;
        this._frameBuffer = playback.frameBuffer;
        this._frameCount = 0;
        this.samplesPerFrame = this.sampleRate * this.machine.cyclesPerFrame / this.machine.clockFrequency;
        return this.sidFile;
    }

    clearBufferedSamples() {
        this._frameReadIndex = 0;
        this._frameSampleCount = 0;
    }

    //
    // Run a few frames to initialize the tune (execute PSID driver setup)
    // @param {number} count - Number of frames to run
    //
    runInitFrames(count, machine = this.machine, buffer = this._frameBuffer) {
        if (!machine) return;
        for (let i = 0; i < count; i++) {
            renderSidFrame(machine, buffer);
        }
        if (machine === this.machine) this.clearBufferedSamples();
    }

    //
    // Run a single frame for visualization updates (when audio may be blocked)
    // This allows register visualization even when AudioContext is suspended.
    //
    runVisualizationFrame() {
        if (!this.machine || !this.isPlaying) return;

        this.clearBufferedSamples();
        renderSidFrame(this.machine, this._frameBuffer);
        this._frameCount++;
    }

    //
    // Set up SID write interception for real-time visualization
    // @private
    //
    setupSIDInterception(machine = this.machine, registers = this.registers,
        writeLog = this.registerWriteLog) {
        if (!machine) return;
        const originalWrite = machine.sid.write.bind(machine.sid);
        machine.sid.write = function (offset, value, cycle) {
            // Capture register for visualization
            registers[offset & 0x1f] = value;

            // Log recent writes
            writeLog.push({
                offset: offset,
                value: value,
                time: Date.now()
            });
            if (writeLog.length > 100) {
                writeLog.shift();
            }

            // Pass through to actual SID
            originalWrite(offset, value, cycle);
        };
    }

    //
    // Change to a specific track (0-based)
    // Success leaves the selected track stopped; failure preserves the old track.
    // @param {number} track - Track index (0-based)
    // @returns {Object} Tune metadata
    //
    changeTrack(track) {
        if (!this.sidFile) throw new Error('No SID file is loaded');
        const playback = this.preparePlayback(this.sidFile, track, 5, this.machine);
        ++this._loadGeneration;
        return this.commitPlayback(playback);
    }

    //
    // Generate audio samples for the output buffer
    // @param {Float32Array} buffer - Output buffer to fill with samples
    // @private
    //
    generateSamples(buffer) {
        if (!this.isPlaying || !this.sidFile || !this.machine) {
            buffer.fill(0);
            return;
        }

        const machine = this.machine;
        let bufferOffset = 0;
        while (bufferOffset < buffer.length) {
            if (this._frameReadIndex >= this._frameSampleCount) {
                this._frameSampleCount = renderSidFrame(machine, this._frameBuffer);
                this._frameReadIndex = 0;
                this._frameCount++;
                if (this.onFrameUpdate) this.onFrameUpdate();
            }
            if (!this.isPlaying || this.machine !== machine) {
                buffer.fill(0, bufferOffset);
                return;
            }
            const count = Math.min(buffer.length - bufferOffset,
                this._frameSampleCount - this._frameReadIndex);
            for (let i = 0; i < count; i++) {
                buffer[bufferOffset++] = this._frameBuffer[this._frameReadIndex++] / 32768;
            }
        }
    }

    //
    // Start playback
    // Concurrent calls share one startup; stop/selection cancels it with AbortError.
    // @returns {Promise<void>}
    //
    play() {
        if (this._playPromise) return this._playPromise;
        if (this.isPlaying) return Promise.resolve();
        if (!this.sidFile || !this.machine) {
            return Promise.reject(new Error('No SID file is loaded'));
        }
        const generation = ++this._playGeneration;
        const cancelled = new Promise((resolve, reject) => {
            this._cancelStart = () => reject(playbackCancelled());
        });
        const pending = Promise.race([this.startPlayback(generation), cancelled]);
        const operation = pending.then(() => {
            this.checkPlaybackGeneration(generation);
        }).catch((error) => {
            if (generation === this._playGeneration) {
                this.isPlaying = false;
                this.disconnectAudioNodes();
                this.clearBufferedSamples();
            }
            throw error;
        }).finally(() => {
            if (this._playPromise === operation) {
                this._playPromise = null;
                this._cancelStart = null;
            }
        });
        this._playPromise = operation;
        return operation;
    }

    checkPlaybackGeneration(generation) {
        if (generation !== this._playGeneration) throw playbackCancelled();
    }

    async startPlayback(generation) {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.sampleRate
            });
        }

        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        this.checkPlaybackGeneration(generation);
        if (this.audioContext.state !== 'running') {
            throw new Error('The audio context could not start playback');
        }

        // Handle sample rate change
        if (this.audioContext.sampleRate !== this.sampleRate) {
            this.sampleRate = this.audioContext.sampleRate;
            this.samplesPerFrame = this.sampleRate * this.machine.cyclesPerFrame / this.machine.clockFrequency;
            this.machine.sampleRate = this.sampleRate;
            this.machine.sid.setSamplingParameters(
                this.machine.clockFrequency, SamplingMethod.DECIMATE, this.sampleRate
            );
            this._frameBuffer = new Int16Array(Math.ceil(this.sampleRate / 50) + 32);
            this.clearBufferedSamples();
        }

        // Try AudioWorklet first
        if (this.audioContext.audioWorklet) {
            let ready = false;
            try {
                await this.setupAudioWorklet(generation);
                ready = true;
            } catch (error) {
                this.checkPlaybackGeneration(generation);
                this.isPlaying = false;
                this.disconnectAudioNodes();
                console.warn('AudioWorklet setup failed, falling back to ScriptProcessor:', error.message);
            }
            if (ready) {
                this.checkPlaybackGeneration(generation);
                // The processor requests its first block too: unsolicited
                // priming would break its one-outstanding-request accounting.
                return;
            }
        }

        this.checkPlaybackGeneration(generation);
        this.setupScriptProcessor(generation);
    }

    //
    // Set up AudioWorklet for audio processing
    // @private
    //
    async registerAudioWorklet(context) {
        const blob = new Blob([sidWorkletProcessorCode], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);
        try {
            await context.audioWorklet.addModule(workletUrl);
        } finally {
            URL.revokeObjectURL(workletUrl);
        }
    }

    async setupAudioWorklet(generation) {
        const context = this.audioContext;
        if (!this._workletModulePromise) {
            this._workletModulePromise = this.registerAudioWorklet(context);
        }
        const registration = this._workletModulePromise;
        try {
            await registration;
        } catch (error) {
            if (this._workletModulePromise === registration) this._workletModulePromise = null;
            throw error;
        }
        this.checkPlaybackGeneration(generation);

        const node = new AudioWorkletNode(context, 'sid-worklet-processor');
        this.workletNode = node;
        this.workletSamples = new Float32Array(this.workletBufferSize);
        node.port.onmessage = (event) => {
            if (event.data.type === 'needSamples' && this.workletNode === node &&
                generation === this._playGeneration) {
                try {
                    this.sendSamplesToWorklet(node);
                } catch (error) {
                    this.stop();
                    console.error('SID playback failed:', error);
                }
            }
        };
        this.useWorklet = true;
        this.isPlaying = true;
        node.connect(context.destination);
        this.checkPlaybackGeneration(generation);
    }

    //
    // Send samples to the AudioWorklet
    // @private
    //
    sendSamplesToWorklet(node = this.workletNode) {
        if (!node || node !== this.workletNode || !this.isPlaying) return;
        this.generateSamples(this.workletSamples);
        if (node !== this.workletNode || !this.isPlaying) return;

        // slice() copies, so it is the copy that gets neutered by the transfer
        // and this.workletSamples stays usable for the next block.
        const buffer = this.workletSamples.buffer.slice(0);
        node.port.postMessage(
            { type: 'samples', buffer: buffer },
            [buffer]
        );
    }

    //
    // Set up ScriptProcessor as fallback
    // @private
    //
    setupScriptProcessor(generation) {
        this.checkPlaybackGeneration(generation);
        const bufferSize = 4096;
        const node = this.audioContext.createScriptProcessor(bufferSize, 0, 1);
        this.scriptNode = node;
        node.onaudioprocess = (e) => {
            const output = e.outputBuffer.getChannelData(0);
            if (this.scriptNode !== node || generation !== this._playGeneration) {
                output.fill(0);
                return;
            }
            try {
                this.generateSamples(output);
            } catch (error) {
                output.fill(0);
                this.stop();
                console.error('SID playback failed:', error);
            }
        };
        this.useWorklet = false;
        this.isPlaying = true;
        node.connect(this.audioContext.destination);
        this.checkPlaybackGeneration(generation);
    }

    //
    // Stop playback
    // The tune stays loaded, but no pending startup may reconnect its audio nodes.
    //
    stop() {
        ++this._playGeneration;
        const cancel = this._cancelStart;
        this._cancelStart = null;
        this._playPromise = null;
        if (cancel) cancel();
        this.isPlaying = false;
        this.disconnectAudioNodes();
        this.clearBufferedSamples();
    }

    disconnectAudioNodes() {
        if (this.workletNode) {
            const node = this.workletNode;
            this.workletNode = null;
            node.port.onmessage = null;
            node.port.close?.();
            try { node.disconnect(); } catch {}
        }
        if (this.scriptNode) {
            const node = this.scriptNode;
            this.scriptNode = null;
            node.onaudioprocess = null;
            try { node.disconnect(); } catch {}
        }
        this.useWorklet = false;
    }

    //
    // Get current state for visualization
    // @returns {Object} Player state including voice info, filter state, and registers
    //
    getState() {
        const frameCount = this._frameCount || 0;
        const elapsedSeconds = this.machine
            ? frameCount * this.machine.cyclesPerFrame / this.machine.clockFrequency
            : 0;

        // Build full register array including read-only registers
        const regs = Array.from(this.registers);

        // Populate read-only registers from actual SID state if available
        // $D419 (25): POTX - not emulated, leave as 0
        // $D41A (26): POTY - not emulated, leave as 0
        // $D41B (27): OSC3 - Voice 3 oscillator output
        // $D41C (28): ENV3 - Voice 3 envelope output
        if (this.machine && this.machine.sid) {
            try {
                // OSC3: Upper 8 bits of voice 3 waveform output
                const osc3 = this.machine.sid.peek(0x1B);
                regs[27] = osc3;

                // ENV3: Voice 3 envelope output (0-255)
                const env3 = this.machine.sid.peek(0x1C);
                regs[28] = env3;
            } catch (e) {
                // Ignore errors reading SID state
            }
        }

        return {
            isPlaying: this.isPlaying,
            currentSong: this.currentSong + 1,
            totalSongs: this.sidFile ? this.sidFile.songs : 0,
            name: this.sidFile ? this.sidFile.name : '',
            author: this.sidFile ? this.sidFile.author : '',
            released: this.sidFile ? this.sidFile.released : '',
            frameCount: frameCount,
            elapsedTime: elapsedSeconds,
            voices: [
                this.getVoiceState(0),
                this.getVoiceState(1),
                this.getVoiceState(2)
            ],
            filter: this.getFilterState(),
            registers: regs
        };
    }

    //
    // Get voice state for visualization
    // @param {number} voice - Voice index (0-2)
    // @returns {Object} Voice state
    // @private
    //
    getVoiceState(voice) {
        const base = voice * 7;
        const freq = this.registers[base] | (this.registers[base + 1] << 8);
        const pw = this.registers[base + 2] | ((this.registers[base + 3] & 0x0f) << 8);
        const ctrl = this.registers[base + 4];
        const ad = this.registers[base + 5];
        const sr = this.registers[base + 6];

        let waveform = 'OFF';
        if (ctrl & 0x80) waveform = 'NOISE';
        else if (ctrl & 0x40) waveform = 'PULSE';
        else if (ctrl & 0x20) waveform = 'SAW';
        else if (ctrl & 0x10) waveform = 'TRI';

        let envelope = 0;
        if (this.machine && this.machine.sid) {
            envelope = this.machine.sid.voice[voice].envelope().output();
        }

        return {
            freq: freq,
            pulseWidth: pw,
            waveform: waveform,
            gate: (ctrl & 0x01) !== 0,
            sync: (ctrl & 0x02) !== 0,
            ring: (ctrl & 0x04) !== 0,
            test: (ctrl & 0x08) !== 0,
            attack: (ad >> 4) & 0x0f,
            decay: ad & 0x0f,
            sustain: (sr >> 4) & 0x0f,
            release: sr & 0x0f,
            envelope: envelope
        };
    }

    //
    // Get filter state for visualization
    // @returns {Object} Filter state
    // @private
    //
    getFilterState() {
        const cutoff = (this.registers[0x15] & 0x07) | (this.registers[0x16] << 3);
        const resFilt = this.registers[0x17];
        const modeVol = this.registers[0x18];

        return {
            cutoff: cutoff,
            resonance: (resFilt >> 4) & 0x0f,
            voices: [
                (resFilt & 0x01) !== 0,
                (resFilt & 0x02) !== 0,
                (resFilt & 0x04) !== 0
            ],
            voice1: (resFilt & 0x01) !== 0,
            voice2: (resFilt & 0x02) !== 0,
            voice3: (resFilt & 0x04) !== 0,
            external: (resFilt & 0x08) !== 0,
            lowPass: (modeVol & 0x10) !== 0,
            bandPass: (modeVol & 0x20) !== 0,
            highPass: (modeVol & 0x40) !== 0,
            voice3Off: (modeVol & 0x80) !== 0,
            volume: modeVol & 0x0f
        };
    }

    //
    // Get register name for debugging
    // @param {number} reg - Register index (0-28)
    // @returns {string} Register name
    // @static
    //
    static getRegisterName(reg) {
        const names = [
            'FREQLO1', 'FREQHI1', 'PWLO1', 'PWHI1', 'CTRL1', 'AD1', 'SR1',
            'FREQLO2', 'FREQHI2', 'PWLO2', 'PWHI2', 'CTRL2', 'AD2', 'SR2',
            'FREQLO3', 'FREQHI3', 'PWLO3', 'PWHI3', 'CTRL3', 'AD3', 'SR3',
            'CUTLO', 'CUTHI', 'RESON', 'VOLUME',
            'POTX', 'POTY', 'OSC3', 'ENV3'
        ];
        return names[reg] || `REG${reg}`;
    }
}

// ============================================================================
// BROWSER LOADER
// ============================================================================

// Expose SIDPlayer on window for browser-based playback (used by sid.html)
if (typeof window !== 'undefined') {
    window.SIDPlayer = SIDPlayer;
    // Only dispatch event if CustomEvent is available (browser environment)
    if (typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(new CustomEvent('sidplayer-ready'));
    }
}
