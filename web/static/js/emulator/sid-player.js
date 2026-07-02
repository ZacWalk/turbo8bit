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
import { generatePsidDriver, DRIVER_ADDRESS } from './psid-driver.js';

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
// Supports PSID v1-v4 and RSID file formats used by the High Voltage SID Collection.
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
    const data = new Uint8Array(buffer);
    const view = new DataView(buffer);

    // Check magic
    const magic = view.getUint32(0, false);
    if (magic !== PSID_MAGIC && magic !== RSID_MAGIC) {
        throw new Error('Not a valid PSID/RSID file');
    }

    const isRSID = magic === RSID_MAGIC;
    const version = view.getUint16(4, false);
    const dataOffset = view.getUint16(6, false);
    // PSID v1 header is 0x76 bytes, v2+ is 0x7C. Reject anything that would
    // point us before the header end or past the end of the file.
    if (dataOffset < 0x76 || dataOffset >= buffer.byteLength) {
        throw new Error(`Invalid PSID/RSID dataOffset: ${dataOffset}`);
    }
    const loadAddress = view.getUint16(8, false);
    const initAddress = view.getUint16(10, false);
    const playAddress = view.getUint16(12, false);
    const songs = view.getUint16(14, false);
    const startSong = view.getUint16(16, false);
    const speed = view.getUint32(18, false);

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
        startSong: startSong || 1,
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
// @param {Object} tune - Parsed SID tune info
// @param {number} song - Song number (0-based)
// @private
//
function installDriver(machine, tune, song) {
    // Generate the driver
    const driver = generatePsidDriver(tune, song);

    // Install all memory regions
    for (const region of driver.regions) {
        machine.loadCode(region.data, region.address);
    }

    // Set memory configuration
    machine.ram[0x0001] = driver.ioPort;

    // Set CPU state
    machine.cpu.PC = driver.cpuState.PC;
    machine.cpu.A = driver.cpuState.A;
    machine.cpu.X = driver.cpuState.X;
    machine.cpu.Y = driver.cpuState.Y;
    machine.cpu.SP = driver.cpuState.SP;
    machine.cpu.P = driver.cpuState.P;
    machine.cpu.halted = false;

    console.log(`SID Player: PSID driver installed at $${DRIVER_ADDRESS.toString(16)}`);
    console.log(`  Init: $${driver.debug.initAddr.toString(16)}, Play: $${driver.debug.playAddr.toString(16)}`);
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
    // Parse the SID file
    const tune = parseSidFile(buffer);

    // Use the specified song or the file's default
    const songNumber = song !== null ? song : tune.startSong;

    console.log(`loadSidTune: Loading "${tune.name}" by ${tune.author}`);
    console.log(`  Load: $${tune.loadAddress.toString(16)}, Init: $${tune.initAddress.toString(16)}, Play: $${tune.playAddress.toString(16)}`);
    console.log(`  Songs: ${tune.songs}, Playing: ${songNumber}`);

    // Reset the machine
    machine.reset();

    // Configure clock and SID model from tune
    if (tune.clock !== machine.clockFrequency) {
        machine.clockFrequency = tune.clock;
        machine.sid.setSamplingParameters(
            machine.clockFrequency,
            SamplingMethod.DECIMATE,
            machine.sampleRate
        );
        // Update cycles per frame for proper timing
        machine.cyclesPerFrame = tune.clock === CLOCK_NTSC
            ? Math.floor(tune.clock / 60)  // NTSC: 60Hz
            : Math.floor(tune.clock / 50); // PAL: 50Hz
    }

    machine.sid.setChipModel(tune.model);

    // Load tune data into RAM
    machine.loadCode(tune.data, tune.loadAddress);

    // Install the PSID driver
    installDriver(machine, tune, songNumber - 1);

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
                if (this.sampleQueue.length > 100) this.sampleQueue.shift();
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

        // C64 machine for emulation
        this.machine = null;

        // Frame timing
        this._frameCount = 0;
        this.samplesPerFrame = 0;
        this.samplesToNextFrame = 0;
        this._frameCyclePos = 0;

        // Callback for UI updates
        this.onFrameUpdate = null;

        // Register snapshot for visualization
        this.registers = new Uint8Array(32);
        this.registerWriteLog = [];
    }

    //
    // Load a SID file from URL
    // @param {string} url - URL to the SID file
    // @returns {Promise<Object>} Parsed SID file info
    //
    async load(url) {
        console.log('SIDPlayer.load:', url);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to load: ${response.statusText}`);
        }
        const buffer = await response.arrayBuffer();
        console.log('SIDPlayer.load: got', buffer.byteLength, 'bytes');
        return this.loadData(buffer);
    }

    //
    // Load SID file from ArrayBuffer
    // @param {ArrayBuffer} buffer - Raw SID file data
    // @returns {Object} Parsed SID file info
    //
    loadData(buffer) {
        console.log('SIDPlayer.loadData:', buffer.byteLength, 'bytes');
        // Create C64 machine
        this.machine = new C64Machine({ sampleRate: this.sampleRate });

        // Set up SID write interception for visualization
        this.setupSIDInterception();

        // Load the tune
        this.sidFile = loadSidTune(this.machine, buffer);
        console.log('SIDPlayer.loadData: loaded tune:', this.sidFile?.name);

        // Initialize timing
        const irqFreq = this.sidFile.clock === CLOCK_NTSC ? 60 : 50;
        this.samplesPerFrame = this.sampleRate / irqFreq;
        this.samplesToNextFrame = this.samplesPerFrame;
        this._frameCount = 0;
        this._frameCyclePos = 0;

        // Set initial track
        this.currentSong = this.sidFile.startSong - 1;

        // Run a few frames to initialize the tune
        this.machine.traceEnabled = true;
        this.machine.traceCount = 0;
        this.runInitFrames(10);

        // DEBUG: Force a write to verify interception
        console.log('SIDPlayer: Testing SID write interception...');
        this.machine.write(0xD400, 0xAA);
        if (this.registers[0] === 0xAA) {
            console.log('SIDPlayer: Interception WORKS! Register $00 captured 0xAA');
        } else {
            console.error('SIDPlayer: Interception FAILED! Register $00 is 0x' + this.registers[0].toString(16));
        }

        return this.sidFile;
    }

    //
    // Run a few frames to initialize the tune (execute PSID driver setup)
    // @param {number} count - Number of frames to run
    //
    runInitFrames(count) {
        if (!this.machine) return;

        for (let i = 0; i < count; i++) {
            this.machine.runFrame();
        }
    }

    //
    // Run a single frame for visualization updates (when audio may be blocked)
    // This allows register visualization even when AudioContext is suspended.
    //
    runVisualizationFrame() {
        if (!this.machine || !this.isPlaying) return;

        this.machine.runFrame();
        this._frameCount++;
    }

    //
    // Set up SID write interception for real-time visualization
    // @private
    //
    setupSIDInterception() {
        if (!this.machine) return;

        console.log('SIDPlayer: Setting up SID interception');
        const self = this;
        const originalWrite = this.machine.sid.write.bind(this.machine.sid);

        this.machine.sid.write = function (offset, value, cycle) {
            // Capture register for visualization (commented out spam log)
            // console.log(`SID Write: $${(0xD400 + offset).toString(16)} = $${value.toString(16)}`);

            // Capture register for visualization
            self.registers[offset & 0x1f] = value;

            // Log recent writes
            self.registerWriteLog.push({
                offset: offset,
                value: value,
                time: Date.now()
            });
            if (self.registerWriteLog.length > 100) {
                self.registerWriteLog.shift();
            }

            // Pass through to actual SID
            originalWrite(offset, value, cycle);
        };
    }

    //
    // Change to a specific track (0-based)
    // @param {number} track - Track index (0-based)
    //
    changeTrack(track) {
        if (!this.sidFile || !this.machine) return;

        this.currentSong = Math.max(0, Math.min(track, this.sidFile.songs - 1));
        this._frameCount = 0;
        this._frameCyclePos = 0;

        // Reset machine and reload tune with new song
        this.machine.reset();

        // Load tune data into RAM
        this.machine.loadCode(this.sidFile.data, this.sidFile.loadAddress);

        // Install the PSID driver for the new song
        installDriver(this.machine, this.sidFile, this.currentSong);

        // Reset timing
        const irqFreq = this.sidFile.clock === CLOCK_NTSC ? 60 : 50;
        this.samplesPerFrame = this.sampleRate / irqFreq;
        this.samplesToNextFrame = this.samplesPerFrame;

        // Clear visualization state
        this.registers.fill(0);
        this.registerWriteLog = [];

        // Run init frames
        this.runInitFrames(5);
    }

    //
    // Generate audio samples for the output buffer
    // @param {Float32Array} buffer - Output buffer to fill with samples
    // @private
    //
    generateSamples(buffer) {
        if (!this.isPlaying) {
            // Log only once per second
            if (!this._silenceLogged || Date.now() - this._silenceLogged > 1000) {
                console.log('generateSamples: not playing, isPlaying=', this.isPlaying, 'sidFile=', !!this.sidFile, 'machine=', !!this.machine);
                this._silenceLogged = Date.now();
            }
            buffer.fill(0);
            return;
        }
        if (!this.sidFile || !this.machine) {
            console.log('generateSamples: missing sidFile or machine');
            buffer.fill(0);
            return;
        }

        // Safety check: ensure timing is initialized
        if (this.samplesPerFrame <= 0) {
            const irqFreq = this.sidFile.clock === CLOCK_NTSC ? 60 : 50;
            this.samplesPerFrame = this.sampleRate / irqFreq;
            this.samplesToNextFrame = this.samplesPerFrame;
            console.log(`generateSamples: initialized timing, samplesPerFrame=${this.samplesPerFrame}`);
        }

        // Log first few calls to track initialization
        if (!this._generateCount) this._generateCount = 0;
        this._generateCount++;
        const shouldLog = this._generateCount <= 3;

        const cyclesPerSample = this.machine.clockFrequency / this.sampleRate;
        let bufferOffset = 0;
        let framesRun = 0;
        // Pre-allocate a reasonably sized temp buffer for Int16 samples from SID
        // This will be reused for each iteration to avoid allocation overhead
        const maxSamplesPerIteration = Math.ceil(this.samplesPerFrame) + 1;
        const tempSamples = new Int16Array(maxSamplesPerIteration);

        while (bufferOffset < buffer.length) {
            // Time to run a new frame?
            if (this.samplesToNextFrame <= 0) {
                this._frameCyclePos = 0;
                // Note: runFrame() calls sid.beginFrame() internally when audioEnabled is true
                this.machine.runFrame();
                this._frameCount++;
                framesRun++;

                const irqFreq = this.sidFile.clock === CLOCK_NTSC ? 60 : 50;
                this.samplesToNextFrame += this.sampleRate / irqFreq;

                if (this.onFrameUpdate) {
                    this.onFrameUpdate();
                }
            }

            const samplesUntilFrame = Math.ceil(this.samplesToNextFrame);
            const samplesNeeded = buffer.length - bufferOffset;
            const samplesToProcess = Math.min(samplesUntilFrame, samplesNeeded);

            if (samplesToProcess <= 0) {
                this.samplesToNextFrame = 0;
                continue;
            }

            const cyclesToProcess = Math.ceil(samplesToProcess * cyclesPerSample);
            const generated = this.machine.sid.clock(cyclesToProcess, tempSamples, this.machine.frameCycleStart + this._frameCyclePos);
            this._frameCyclePos += cyclesToProcess;

            for (let i = 0; i < generated && bufferOffset < buffer.length; i++) {
                buffer[bufferOffset++] = tempSamples[i] / 32768;
            }

            this.samplesToNextFrame -= generated || samplesToProcess;
        }

        // Log first few calls
        if (shouldLog) {
            console.log(`generateSamples #${this._generateCount}: framesRun=${framesRun}, bufferFilled=${bufferOffset}, totalFrames=${this._frameCount}, cpuPC=0x${this.machine.cpu.PC.toString(16)}, cpuHalted=${this.machine.cpu.halted}`);
        }
    }

    //
    // Start playback
    // @returns {Promise<void>}
    //
    async play() {
        console.log('SIDPlayer.play called, sidFile=', !!this.sidFile);
        if (!this.sidFile) {
            console.error('No SID file loaded');
            return;
        }

        // Reset trace for playback
        if (this.machine) {
            this.machine.traceEnabled = true;
            this.machine.traceCount = 0;
        }

        if (!this.audioContext) {
            console.log('SIDPlayer.play: creating AudioContext');
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.sampleRate
            });
        }

        if (this.audioContext.state === 'suspended') {
            console.log('SIDPlayer.play: resuming AudioContext');
            await this.audioContext.resume();
        }
        console.log('SIDPlayer.play: AudioContext state=', this.audioContext.state);

        // Handle sample rate change
        if (this.audioContext.sampleRate !== this.sampleRate) {
            console.log(`SIDPlayer: Updating sample rate from ${this.sampleRate} to ${this.audioContext.sampleRate}`);
            this.sampleRate = this.audioContext.sampleRate;

            const irqFreq = this.sidFile.clock === CLOCK_NTSC ? 60 : 50;
            this.samplesPerFrame = this.sampleRate / irqFreq;
            this.samplesToNextFrame = this.samplesPerFrame;

            if (this.machine) {
                this.machine.sid.setSamplingParameters(
                    this.machine.clockFrequency,
                    SamplingMethod.DECIMATE,
                    this.sampleRate
                );
            }
        }

        // Try AudioWorklet first
        if (this.audioContext.audioWorklet) {
            try {
                console.log('SIDPlayer.play: trying AudioWorklet');
                // Set isPlaying BEFORE setup to avoid race condition
                this.isPlaying = true;
                await this.setupAudioWorklet();
                console.log('SIDPlayer.play: AudioWorklet set up, isPlaying=true');
                return;
            } catch (e) {
                this.isPlaying = false;  // Reset on failure
                console.warn('AudioWorklet setup failed, falling back to ScriptProcessor:', e.message);
            }
        }

        // Fallback to ScriptProcessor
        console.log('SIDPlayer.play: using ScriptProcessor');
        // Set isPlaying BEFORE setupScriptProcessor() to avoid race condition
        // where onaudioprocess fires before isPlaying is set
        this.isPlaying = true;
        this.setupScriptProcessor();
        console.log('SIDPlayer.play: ScriptProcessor set up, isPlaying=true');
    }

    //
    // Set up AudioWorklet for audio processing
    // @private
    //
    async setupAudioWorklet() {
        if (!this.audioContext._sidWorkletRegistered) {
            const blob = new Blob([sidWorkletProcessorCode], { type: 'application/javascript' });
            const workletUrl = URL.createObjectURL(blob);

            try {
                await this.audioContext.audioWorklet.addModule(workletUrl);
                this.audioContext._sidWorkletRegistered = true;
            } finally {
                URL.revokeObjectURL(workletUrl);
            }
        }

        this.workletNode = new AudioWorkletNode(this.audioContext, 'sid-worklet-processor');
        this.workletNode.connect(this.audioContext.destination);

        this.workletSamples = new Float32Array(this.workletBufferSize);

        this.workletNode.port.onmessage = (event) => {
            if (event.data.type === 'needSamples') {
                this.sendSamplesToWorklet();
            }
        };

        // Log driver state before sending first samples
        console.log('SIDPlayer: Worklet setup, checking driver state...');
        console.log(`  machine.ram[0x01] = 0x${this.machine.ram[0x01].toString(16)}`);
        console.log(`  IRQ vector = 0x${(this.machine.ram[0xFFFE] | (this.machine.ram[0xFFFF] << 8)).toString(16)}`);
        console.log(`  CPU PC = 0x${this.machine.cpu.PC.toString(16)}, halted = ${this.machine.cpu.halted}`);

        this.sendSamplesToWorklet();
        this.useWorklet = true;
        console.log('SIDPlayer: Using AudioWorklet for playback');
    }

    //
    // Send samples to the AudioWorklet
    // @private
    //
    sendSamplesToWorklet() {
        if (!this.workletNode || !this.isPlaying) {
            console.log('sendSamplesToWorklet: skipped, workletNode=', !!this.workletNode, 'isPlaying=', this.isPlaying);
            return;
        }

        // Track sample sending
        if (!this._workletSendCount) this._workletSendCount = 0;
        this._workletSendCount++;

        this.generateSamples(this.workletSamples);

        // Check if we're generating actual audio
        let min = 0, max = 0, nonZero = 0;
        for (let i = 0; i < this.workletSamples.length; i++) {
            const s = this.workletSamples[i];
            if (s < min) min = s;
            if (s > max) max = s;
            if (s !== 0) nonZero++;
        }

        if (this._workletSendCount <= 5 || this._workletSendCount % 50 === 0) {
            console.log(`sendSamplesToWorklet #${this._workletSendCount}: nonZero=${nonZero}, min=${min.toFixed(4)}, max=${max.toFixed(4)}, frameCount=${this._frameCount}`);
        }

        const buffer = this.workletSamples.buffer.slice(0);
        this.workletNode.port.postMessage(
            { type: 'samples', buffer: buffer },
            [buffer]
        );

        // Reallocate the Float32Array since we transferred the buffer
        this.workletSamples = new Float32Array(this.workletBufferSize);
    }

    //
    // Set up ScriptProcessor as fallback
    // @private
    //
    setupScriptProcessor() {
        const bufferSize = 4096;
        this.scriptNode = this.audioContext.createScriptProcessor(bufferSize, 0, 1);

        this.scriptNode.onaudioprocess = (e) => {
            const output = e.outputBuffer.getChannelData(0);
            this.generateSamples(output);
        };

        this.scriptNode.connect(this.audioContext.destination);
        this.useWorklet = false;
        console.log('SIDPlayer: Using ScriptProcessor for playback');
    }

    //
    // Stop playback
    //
    stop() {
        this.isPlaying = false;

        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }

        if (this.scriptNode) {
            this.scriptNode.disconnect();
            this.scriptNode = null;
        }
    }

    //
    // Get current state for visualization
    // @returns {Object} Player state including voice info, filter state, and registers
    //
    getState() {
        const frameCount = this._frameCount || 0;
        const irqFreq = this.sidFile?.clock === CLOCK_NTSC ? 60 : 50;
        const elapsedSeconds = frameCount / irqFreq;

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
                const osc3 = this.machine.sid.read(0x1B);  // Read from offset $1B
                regs[27] = osc3;

                // ENV3: Voice 3 envelope output (0-255)
                const env3 = this.machine.sid.voice[2].envelope().output();
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
    console.log('SID Player loaded (C64Machine-based)');
}
