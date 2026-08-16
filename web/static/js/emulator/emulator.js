//
// @fileoverview C64 Emulator UI - Entry point for visual C64 emulation in Turbo8bit
// @module emulator/emulator
//
// This is the main entry point for the visual C64 emulator. Import this module
// in index.html or any page that needs the full C64 experience with screen output.
//
// Provides:
// - Canvas rendering with VIC-II character and sprite display
// - Web Audio API output for SID sound
// - Keyboard input handling
// - Session persistence (snapshot/restore)
//
// Browser Usage (index.html):
//   <script type="module">
//     import { C64Emulator } from '/static/js/emulator/emulator.js';
//     const emulator = new C64Emulator('screen');
//     emulator.start();
//   </script>
//
// For SID-only playback without visual emulation, see sid-player.js.
// For the core machine emulation (CPU, memory, I/O), see machine.js.
// For VIC-II graphics rendering, see vic-ii.js.
//
// @see https://www.turbo8bit.com/
//

import { C64Machine } from './machine.js';
import { ChipModel, SamplingMethod } from './sid.js';
import {
    VICIIRenderer,
} from './vic-ii.js';

// Ring buffer between the emulation loop and the Web Audio callback. Both run
// on the main thread, but at unrelated rates (50Hz frames vs 2048-sample
// blocks), so the buffer is what decouples them. Size must be a power of two
// so the index can be masked.
const AUDIO_RING_SIZE = 8192;
const AUDIO_RING_MASK = AUDIO_RING_SIZE - 1;

// Upper bound on the samples one emulated frame can produce (a 50Hz PAL frame
// is ~882 samples at 44.1kHz, ~960 at 48kHz). Resized in initAudio() once the
// real sample rate is known.
const AUDIO_FRAME_SAMPLES = 2048;

// How far ahead of the audio callback the emulation loop is allowed to get.
// This is the output latency, so keep it to a couple of ScriptProcessor blocks.
// Excess builds up during start-up, before the first callback fires, and is
// trimmed once.
const AUDIO_MAX_LEAD = 4096;

// ============================================================================
// KEYBOARD MATRIX MAPPING
// ============================================================================
//
// The C64 matrix is 8 rows (CIA1 port A) by 8 columns (CIA1 port B). Mapping a
// PC keyboard onto it is not a straight lookup, because the two keyboards put
// SHIFT in different places: `*` is SHIFT+8 on a PC but an unshifted key on the
// C64, while `'` is unshifted on a PC and SHIFT+7 on the C64. So each entry also
// records what the C64's SHIFT must be doing while that key is down.

// Keys that take the C64 SHIFT from whatever the user is physically holding.
// Letters are here deliberately: unshifted letters already produce uppercase
// PETSCII, and SHIFT+letter is a graphics character, exactly as on real hardware.
const KEY_MATRIX = {
    'Backspace': [0, 0], 'Delete': [0, 0],
    'Enter': [0, 1],
    'ArrowRight': [0, 2],
    'F7': [0, 3], 'F1': [0, 4], 'F3': [0, 5], 'F5': [0, 6],
    'ArrowDown': [0, 7],

    '3': [1, 0], 'w': [1, 1], 'a': [1, 2], '4': [1, 3],
    'z': [1, 4], 's': [1, 5], 'e': [1, 6],

    '5': [2, 0], 'r': [2, 1], 'd': [2, 2], '6': [2, 3],
    'c': [2, 4], 'f': [2, 5], 't': [2, 6], 'x': [2, 7],

    '7': [3, 0], 'y': [3, 1], 'g': [3, 2], '8': [3, 3],
    'b': [3, 4], 'h': [3, 5], 'u': [3, 6], 'v': [3, 7],

    '9': [4, 0], 'i': [4, 1], 'j': [4, 2], '0': [4, 3],
    'm': [4, 4], 'k': [4, 5], 'o': [4, 6], 'n': [4, 7],

    'p': [5, 1], 'l': [5, 2],

    'Home': [6, 3],

    '1': [7, 0], 'Control': [7, 2], '2': [7, 3], ' ': [7, 4],
    'Alt': [7, 5], 'q': [7, 6], 'Escape': [7, 7]
};

// Unshifted C64 keys. Several of these need SHIFT on a PC to type at all, so the
// C64's SHIFT has to be forced off or the KERNAL decodes a graphics character.
const UNSHIFTED_KEY_MATRIX = {
    '+': [5, 0], '-': [5, 3], '.': [5, 4], ':': [5, 5], '@': [5, 6], ',': [5, 7],
    '\\': [6, 0], '*': [6, 1], ';': [6, 2], '=': [6, 5], '^': [6, 6], '/': [6, 7]
};

// Shifted C64 keys. CRSR left/up are shifted CRSR right/down, F2/F4/F6/F8 are
// shifted F1/F3/F5/F7, and the punctuation sits on the shifted number row.
const SHIFTED_KEY_MATRIX = {
    'ArrowLeft': [0, 2], 'ArrowUp': [0, 7],
    'F8': [0, 3], 'F2': [0, 4], 'F4': [0, 5], 'F6': [0, 6],
    '!': [7, 0],   // SHIFT+1
    '"': [7, 3],   // SHIFT+2
    '#': [1, 0],   // SHIFT+3
    '$': [1, 3],   // SHIFT+4
    '%': [2, 0],   // SHIFT+5
    '&': [2, 3],   // SHIFT+6
    "'": [3, 0],   // SHIFT+7
    '(': [3, 3],   // SHIFT+8
    ')': [4, 0],   // SHIFT+9
    '[': [5, 5],   // SHIFT+:
    ']': [6, 2],   // SHIFT+;
    '>': [5, 4],   // SHIFT+.
    '<': [5, 7],   // SHIFT+,
    '?': [6, 7]    // SHIFT+/
};

// Left SHIFT. Only updateShiftKey() may touch this position.
const SHIFT_KEY = [1, 7];

//
// Resolve a KeyboardEvent.key into a matrix position and its SHIFT requirement.
// @returns {{row: number, col: number, shift: 'on'|'off'|'auto'}|null}
//
function lookupKey(key) {
    const shifted = SHIFTED_KEY_MATRIX[key];
    if (shifted) return { row: shifted[0], col: shifted[1], shift: 'on' };

    const unshifted = UNSHIFTED_KEY_MATRIX[key];
    if (unshifted) return { row: unshifted[0], col: unshifted[1], shift: 'off' };

    const normal = KEY_MATRIX[key] || KEY_MATRIX[key.toLowerCase()];
    if (normal) return { row: normal[0], col: normal[1], shift: 'auto' };

    return null;
}

//
// C64Emulator - Visual C64 emulator with canvas rendering and audio
//
// Wraps a C64Machine and provides:
// - Visual output via canvas rendering
// - Audio output via Web Audio API
// - Keyboard input handling
// - Main loop with frame timing
//
export class C64Emulator {
    constructor(id, options = {}) {
        this.canvas = document.getElementById(id);
        this.ctx = this.canvas.getContext('2d');
        this.ctx.imageSmoothingEnabled = false;

        // Internal resolution includes border: 384x272. The displayed size and
        // its 4:3 CRT aspect ratio are CSS's job (see #screen in style.css).
        this.canvas.width = 384;
        this.canvas.height = 272;

        // Audio settings
        this.audioEnabled = options.audioEnabled !== false;
        this.sampleRate = options.sampleRate || 44100;

        // Create machine with audio settings
        this.machine = new C64Machine({
            audioEnabled: this.audioEnabled,
            sampleRate: this.sampleRate,
            chipModel: options.chipModel || ChipModel.MOS6581
        });

        this.frame = 0;
        this.running = false;
        this.paused = false;  // For debug stepping mode
        this.lastTime = 0;
        this.timeAccumulator = 0;

        // Joystick emulation state
        // When activeJoystick is 1 or 2, arrow keys control that joystick
        // When 0, arrow keys work as normal cursor keys
        this.activeJoystick = 0;
        this.joystickState = { up: false, down: false, left: false, right: false, fire: false };

        // True while the user is physically holding a PC Shift key.
        this.physicalShift = false;

        // Keys currently down, mapped to their matrix position and the frame
        // they went down on, plus releases deferred until that frame has run.
        this.heldKeys = new Map();
        this.pendingReleases = [];

        // VIC-II renderer
        this.vicRenderer = new VICIIRenderer(this.canvas.width, this.canvas.height);

        // Audio driver (initialized when started)
        this.audioContext = null;
        this.audioProcessor = null;

        // The emulation loop is the audio producer and the Web Audio callback is
        // the consumer, so samples pass between them through a ring buffer. One
        // PAL frame is ~882 samples at 44.1kHz; 8192 gives ~9 frames of slack.        this.audioRing = new Float32Array(AUDIO_RING_SIZE);
        this.ringWrite = 0;
        this.ringRead = 0;
        this.frameSamples = new Int16Array(AUDIO_FRAME_SAMPLES);
        this.lastSample = 0;
    }

    reset() {
        // Eject any loaded cartridge on reset
        this.machine.ejectCartridge();
        this.machine.reset();
    }

    //
    // Start the emulator with optional audio
    //
    async start() {
        if (this.running) return;

        this.running = true;

        // Initialize audio if enabled
        if (this.audioEnabled) {
            await this.initAudio();
        }

        this.lastTime = performance.now();
        this.timeAccumulator = 0;
        this.loop();
    }

    //
    // Initialize Web Audio API for sound output
    //
    async initAudio() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.sampleRate
            });

            // The browser is free to ignore the requested rate (Safari always
            // uses the hardware rate), so resample the SID to whatever we got.
            if (this.audioContext.sampleRate !== this.sampleRate) {
                this.sampleRate = this.audioContext.sampleRate;
                this.machine.sampleRate = this.sampleRate;
                this.machine.sid.setSamplingParameters(
                    this.machine.clockFrequency,
                    SamplingMethod.DECIMATE,
                    this.sampleRate
                );
            }

            this.ringWrite = 0;
            this.ringRead = 0;
            this.audioRing.fill(0);

            // One frame's worth of samples, plus slack for rounding.
            const frameSamples = Math.ceil(this.sampleRate / 50) + 64;
            if (this.frameSamples.length < frameSamples) {
                this.frameSamples = new Int16Array(frameSamples);
            }

            // Create a ScriptProcessorNode for audio generation
            // Note: This is deprecated but widely supported. AudioWorklet requires more setup.
            const bufferSize = 2048;
            this.audioProcessor = this.audioContext.createScriptProcessor(bufferSize, 0, 1);

            this.audioProcessor.onaudioprocess = (event) => {
                this.drainAudio(event.outputBuffer.getChannelData(0));
            };

            this.audioProcessor.connect(this.audioContext.destination);
            // Modern browsers start the AudioContext in 'suspended' state until
            // explicitly resumed; enableAudio() is invoked from a user gesture
            // so this is allowed.
            if (this.audioContext.state === 'suspended') {
                try { await this.audioContext.resume(); } catch (e) { /* ignore */ }
            }
        } catch (e) {
            console.warn('Failed to initialize audio:', e);
            this.audioEnabled = false;
            // Otherwise runFrame keeps queueing SID writes nothing will retire.
            this.machine.audioEnabled = false;
        }
    }

    //
    // Copy one emulated frame's SID output into the ring buffer.
    // Audio produced while the ring is full is dropped rather than allowed to
    // overwrite samples the audio thread has not played yet.
    // @private
    //
    pushFrameAudio() {
        const count = this.machine.audioSamplesGenerated;
        if (count <= 0) return;

        const free = AUDIO_RING_SIZE - (this.ringWrite - this.ringRead);
        const toCopy = Math.min(count, free);

        for (let i = 0; i < toCopy; i++) {
            this.audioRing[(this.ringWrite + i) & AUDIO_RING_MASK] = this.frameSamples[i] / 32768;
        }
        this.ringWrite += toCopy;

        // Keep latency bounded by discarding audio the listener has not reached
        // yet, rather than letting the backlog grow up to the ring size.
        const lead = this.ringWrite - this.ringRead;
        if (lead > AUDIO_MAX_LEAD) {
            this.ringRead = this.ringWrite - AUDIO_MAX_LEAD;
        }
    }

    //
    // Fill a Web Audio output block from the ring buffer.
    // On underrun the last sample is held rather than dropping to zero, which
    // would produce an audible click on every gap.
    // @private
    //
    drainAudio(output) {
        const available = this.ringWrite - this.ringRead;
        const toCopy = Math.min(output.length, available);

        for (let i = 0; i < toCopy; i++) {
            output[i] = this.audioRing[(this.ringRead + i) & AUDIO_RING_MASK];
        }
        this.ringRead += toCopy;

        if (toCopy > 0) {
            this.lastSample = output[toCopy - 1];
        }
        for (let i = toCopy; i < output.length; i++) {
            this.lastSample *= 0.995;  // decay towards silence
            output[i] = this.lastSample;
        }
    }

    stop() {
        this.running = false;
        this.teardownAudio();
    }

    //
    // Disconnect and release the Web Audio graph
    // @private
    //
    teardownAudio() {
        if (this.audioProcessor) {
            this.audioProcessor.onaudioprocess = null;
            this.audioProcessor.disconnect();
            this.audioProcessor = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.ringWrite = 0;
        this.ringRead = 0;
        this.lastSample = 0;
    }

    //
    // Pause emulator execution (for debug stepping)
    // The emulator loop keeps running but doesn't execute CPU cycles
    //
    pause() {
        this.paused = true;
    }

    //
    // Resume emulator execution after pausing
    //
    resume() {
        this.paused = false;
    }

    //
    // Check if emulator is paused
    //
    isPaused() {
        return this.paused;
    }

    //
    // Enable audio output (lazy initialization)
    // Called when user unmutes - audio will start when SID is written to
    //
    async enableAudio() {
        if (this.audioEnabled) return; // Already enabled

        this.audioEnabled = true;
        this.machine.audioEnabled = true;
        await this.initAudio();
    }

    //
    // Disable audio output
    //
    disableAudio() {
        if (!this.audioEnabled) return; // Already disabled

        this.audioEnabled = false;
        this.machine.audioEnabled = false;
        this.teardownAudio();
    }

    breakExecution() {
        // Force a CPU break (emulates RUN/STOP key behavior in software)
        this.machine.pressStop();
    }

    loop() {
        if (!this.running) return;

        const now = performance.now();
        let dt = now - this.lastTime;
        this.lastTime = now;

        // Cap dt to prevent spiral of death if tab is backgrounded
        if (dt > 100) dt = 100;

        // If paused (debug stepping mode), don't run frames but keep loop alive
        if (this.paused) {
            // Just render the current state and continue the loop
            this.render();
            requestAnimationFrame(() => this.loop());
            return;
        }

        this.timeAccumulator += dt;

        // PAL C64 is 50.125 Hz approx
        const frameTime = 1000 / 50.125;
        let framesRun = 0;

        while (this.timeAccumulator >= frameTime) {
            if (this.audioEnabled && this.audioProcessor) {
                this.machine.runFrame(this.frameSamples);
                this.pushFrameAudio();
            } else {
                this.machine.runFrame();
            }
            this.timeAccumulator -= frameTime;
            this.frame++;
            framesRun++;

            // Don't run too many frames in one go to keep UI responsive
            if (framesRun > 5) {
                this.timeAccumulator = 0;
                break;
            }
        }

        // Render if we updated the state
        if (framesRun > 0) {
            this.render();
        }

        // Every deferred key has now been held through a full frame, so the
        // KERNAL's scan has had a chance to see it.
        if (framesRun > 0 && this.pendingReleases.length > 0) {
            for (const held of this.pendingReleases) {
                this.machine.setKey(held.row, held.col, false);
            }
            this.pendingReleases.length = 0;
            this.updateShiftKey();
        }

        requestAnimationFrame(() => this.loop());
    }

    render() {
        this.vicRenderer.render(this.ctx, this.machine.vic);
    }

    handleKeyPress(e) {
        // If joystick mode is active, handle arrow keys and space as joystick
        if (this.activeJoystick > 0) {
            const k = e.key;
            if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight' || k === ' ') {
                this.handleJoystickKey(k, true);
                e.preventDefault();
                return;
            }
        }

        if (e.key === 'Shift') {
            this.physicalShift = true;
            this.updateShiftKey();
            e.preventDefault();
            return;
        }

        const mapped = lookupKey(e.key);
        if (!mapped) return;
        e.preventDefault();

        // The OS repeats keydown while a key is held. Ignore the repeats: the
        // C64's own repeat comes from the KERNAL scanning the held matrix, and
        // re-recording the press would keep pushing the release frame forward.
        if (this.heldKeys.has(e.key)) return;

        this.heldKeys.set(e.key, { ...mapped, frame: this.frame });
        this.machine.setKey(mapped.row, mapped.col, true);
        this.updateShiftKey();
    }

    //
    // Handle key release events
    //
    handleKeyRelease(e) {
        // Only handle joystick key releases when joystick mode is active
        if (this.activeJoystick > 0) {
            const k = e.key;
            if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight' || k === ' ') {
                this.handleJoystickKey(k, false);
                e.preventDefault();
                return;
            }
        }

        if (e.key === 'Shift') {
            this.physicalShift = false;
            this.updateShiftKey();
            e.preventDefault();
            return;
        }

        const held = this.heldKeys.get(e.key);
        if (!held) return;
        this.heldKeys.delete(e.key);
        e.preventDefault();

        // The KERNAL only scans the matrix once per frame. A keypress that both
        // starts and ends inside the same frame would never be seen, so defer
        // its release until at least one frame has run with the key down.
        if (held.frame === this.frame) {
            this.pendingReleases.push(held);
        } else {
            this.machine.setKey(held.row, held.col, false);
        }
        this.updateShiftKey();
    }

    //
    // Drive the C64's SHIFT key. A held key can demand SHIFT (C64 shifted
    // punctuation), forbid it (a C64 unshifted key the PC can only reach with
    // shift, like `*`), or defer to whatever the user is physically holding.
    // Keys awaiting a deferred release still count, so SHIFT cannot drop before
    // the KERNAL has scanned them.
    // @private
    //
    updateShiftKey() {
        let required = null;
        for (const held of [...this.heldKeys.values(), ...this.pendingReleases]) {
            if (held.shift === 'on') { required = true; break; }
            if (held.shift === 'off') required = false;
        }
        const down = required === null ? this.physicalShift : required;
        this.machine.setKey(SHIFT_KEY[0], SHIFT_KEY[1], down);
    }

    //
    // Release every held key. Called when the page loses focus so that keys
    // held during an alt-tab do not stay down in the emulated machine.
    //
    releaseAllKeys() {
        this.machine.releaseAllKeys();
        this.heldKeys.clear();
        this.pendingReleases.length = 0;
        this.physicalShift = false;
        if (this.activeJoystick > 0) {
            for (const button of Object.keys(this.joystickState)) {
                this.joystickState[button] = false;
                this.machine.setJoystickButton(this.activeJoystick, button, false);
            }
        }
    }

    //
    // Handle a joystick key press/release
    // @param {string} key - Key name ('ArrowUp', 'ArrowDown', etc. or ' ')
    // @param {boolean} pressed - True if pressed, false if released
    //
    handleJoystickKey(key, pressed) {
        let button = null;
        switch (key) {
            case 'ArrowUp': button = 'up'; break;
            case 'ArrowDown': button = 'down'; break;
            case 'ArrowLeft': button = 'left'; break;
            case 'ArrowRight': button = 'right'; break;
            case ' ': button = 'fire'; break;
        }
        if (button) {
            this.joystickState[button] = pressed;
            this.machine.setJoystickButton(this.activeJoystick, button, pressed);
        }
    }

    //
    // Enable joystick mode (arrow keys + space control joystick)
    // @param {number} port - Joystick port (1 or 2), or 0 to disable
    //
    setActiveJoystick(port) {
        // Reset any currently pressed buttons
        if (this.activeJoystick > 0) {
            const oldPort = this.activeJoystick;
            Object.keys(this.joystickState).forEach(button => {
                if (this.joystickState[button]) {
                    this.machine.setJoystickButton(oldPort, button, false);
                    this.joystickState[button] = false;
                }
            });
        }
        this.activeJoystick = port;
    }

    //
    // Toggle joystick mode for a specific port
    // @param {number} port - Joystick port (1 or 2)
    // @returns {boolean} True if joystick is now active, false if disabled
    //
    toggleJoystick(port) {
        if (this.activeJoystick === port) {
            this.setActiveJoystick(0);
            return false;
        } else {
            this.setActiveJoystick(port);
            return true;
        }
    }

    //
    // Type text into the machine programmatically.
    //
    // This injects PETSCII straight into the KERNAL keyboard buffer rather than
    // going through the matrix, so it cannot collide with keys the user is
    // physically holding and needs no press/release timing.
    //
    typeText(t) {
        let delay = 0;
        for (const ch of t) {
            if (ch === '\r') continue;  // CR/LF pairs are handled by the LF
            const code = ch === '\n' ? 13 : ch.toUpperCase().charCodeAt(0);
            setTimeout(() => this.machine.addKey(code), delay);
            delay += ch === '\n' ? 70 : 30;  // longer pause after a line
        }
    }

    snapshot() {
        return {
            ram: Array.from(this.machine.ram),
            cpu: {
                A: this.machine.cpu.A,
                X: this.machine.cpu.X,
                Y: this.machine.cpu.Y,
                SP: this.machine.cpu.SP,
                PC: this.machine.cpu.PC,
                P: this.machine.cpu.P
            },
            frame: this.frame
        };
    }

    restore(state) {
        if (!state || !state.ram || !state.cpu) return;
        try {
            const r = state.ram;
            if (r.length === 65536) {
                this.machine.ram.set(r);
            }
            // Handle both old and new property names
            this.machine.cpu.A = state.cpu.A ?? state.cpu.a ?? 0;
            this.machine.cpu.X = state.cpu.X ?? state.cpu.x ?? 0;
            this.machine.cpu.Y = state.cpu.Y ?? state.cpu.y ?? 0;
            this.machine.cpu.SP = state.cpu.SP ?? state.cpu.sp ?? 0xff;
            this.machine.cpu.PC = state.cpu.PC ?? state.cpu.pc ?? 0;
            this.machine.cpu.P = state.cpu.P ?? state.cpu.status ?? 0x24;
            this.frame = state.frame || 0;
        } catch (e) {
            console.warn('Failed to restore C64 state', e);
        }
    }

    //
    // Enable drag-and-drop of PRG files onto the emulator canvas
    //
    // When a .prg file is dropped, it will be loaded into memory and executed.
    //
    enableDragAndDrop() {
        const canvas = this.canvas;

        // Prevent default drag behaviors
        canvas.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            canvas.classList.add('drag-over');
        });

        canvas.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            canvas.classList.remove('drag-over');
        });

        canvas.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            canvas.classList.remove('drag-over');

            const files = e.dataTransfer.files;
            if (files.length === 0) return;

            const file = files[0];
            const name = file.name.toLowerCase();

            try {
                const arrayBuffer = await file.arrayBuffer();
                const data = new Uint8Array(arrayBuffer);

                // Handle different file types
                if (name.endsWith('.prg')) {
                    this.loadPrgFile(data, file.name);
                } else if (name.endsWith('.crt')) {
                    this.loadCrtFile(data, file.name);
                } else {
                    console.warn('Unsupported file type. Supported: .prg, .crt');
                }
            } catch (err) {
                console.error('Failed to load file:', err);
            }
        });
    }

    //
    // Load a PRG file into memory
    //
    // @param {Uint8Array} data - The PRG file data (with 2-byte load address header)
    // @param {string} [filename] - Optional filename for logging
    //
    loadPrgFile(data, filename = 'program.prg') {
        if (data.length < 3) {
            console.error('PRG file too small');
            return;
        }

        // Load the PRG into memory
        const loadAddress = this.machine.loadPrg(data);
        const endAddress = loadAddress + data.length - 2 - 1;

        console.log(`Loaded ${filename}: $${loadAddress.toString(16).padStart(4, '0')}-$${endAddress.toString(16).padStart(4, '0')} (${data.length - 2} bytes)`);
    }

    //
    // Load a CRT cartridge file and reset the machine
    //
    // @param {Uint8Array} data - The CRT file data
    // @param {string} [filename] - Optional filename for logging
    //
    loadCrtFile(data, filename = 'cartridge.crt') {
        try {
            this.machine.loadCrt(data);
            this.machine.reset();
        } catch (err) {
            console.error(`Failed to load ${filename}:`, err.message);
        }
    }
}

// Session persistence helpers
if (typeof window !== 'undefined') {
    function saveState() {
        if (window.c64Emu && typeof window.c64Emu.snapshot === 'function') {
            try {
                const snap = window.c64Emu.snapshot();
                sessionStorage.setItem('c64State', JSON.stringify(snap));
            } catch (e) {
                // ignore
            }
        }
    }
    window.addEventListener('beforeunload', saveState);
    window.addEventListener('pagehide', saveState);
}