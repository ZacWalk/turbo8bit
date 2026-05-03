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
import { ChipModel } from './sid.js';
import {
    VICIIRenderer,
} from './vic-ii.js';

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
        this.scale = 2;

        // Internal resolution includes border: 384x272
        this.canvas.width = 384;
        this.canvas.height = 272;

        // 4:3 aspect ratio like original CRT
        const displayHeight = this.canvas.height * this.scale;
        const targetAspect = 4 / 3;
        const displayWidth = Math.round(displayHeight * targetAspect);
        this.canvas.style.height = displayHeight + "px";
        this.canvas.style.width = displayWidth + "px";
        this.canvas.style.maxWidth = displayWidth + "px";

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

        // VIC-II renderer
        this.vicRenderer = new VICIIRenderer(this.canvas.width, this.canvas.height);

        // Audio driver (initialized when started)
        this.audioContext = null;
        this.audioWorklet = null;
        this.audioBuffer = null;

        // Debug info
        console.log('Emulator initialized. Checking reset vector...');
        const resetLo = this.machine.read(0xFFFC);
        const resetHi = this.machine.read(0xFFFD);
        const resetVector = resetLo | (resetHi << 8);
        console.log(`Reset vector: 0x${resetVector.toString(16).padStart(4, '0')}`);
        console.log(`Current CPU PC: 0x${this.machine.cpu.PC.toString(16).padStart(4, '0')}`);
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

        console.log('Starting emulator main loop...');
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

            // Create a ScriptProcessorNode for audio generation
            // Note: This is deprecated but widely supported. AudioWorklet requires more setup.
            const bufferSize = 2048;
            this.audioProcessor = this.audioContext.createScriptProcessor(bufferSize, 0, 1);
            this.audioBuffer = new Int16Array(bufferSize);

            this.audioProcessor.onaudioprocess = (event) => {
                const output = event.outputBuffer.getChannelData(0);

                // Generate audio from SID
                const samplesGenerated = this.machine.generateAudio(this.audioBuffer);

                // Convert Int16 to Float32 for Web Audio
                for (let i = 0; i < output.length; i++) {
                    if (i < samplesGenerated) {
                        output[i] = this.audioBuffer[i] / 32768;
                    } else {
                        output[i] = 0;
                    }
                }
            };

            this.audioProcessor.connect(this.audioContext.destination);
            // Modern browsers start the AudioContext in 'suspended' state until
            // explicitly resumed; enableAudio() is invoked from a user gesture
            // so this is allowed.
            if (this.audioContext.state === 'suspended') {
                try { await this.audioContext.resume(); } catch (e) { /* ignore */ }
            }
            console.log('Audio initialized at', this.sampleRate, 'Hz');
        } catch (e) {
            console.warn('Failed to initialize audio:', e);
            this.audioEnabled = false;
        }
    }

    stop() {
        this.running = false;
        if (this.audioProcessor) {
            this.audioProcessor.disconnect();
        }
        if (this.audioContext) {
            this.audioContext.close();
        }
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
        console.log('Audio enabled');
    }

    //
    // Disable audio output
    //
    disableAudio() {
        if (!this.audioEnabled) return; // Already disabled

        this.audioEnabled = false;
        this.machine.audioEnabled = false;

        if (this.audioProcessor) {
            this.audioProcessor.disconnect();
            this.audioProcessor = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        console.log('Audio disabled');
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
            this.machine.runFrame();
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

        let code = 0;
        const k = e.key;
        if (k === 'Escape') {
            // RUN/STOP key
            this.machine.pressStop();
            e.preventDefault();
            return;
        }
        if (k === 'Enter') code = 13;
        else if (k === 'Backspace') code = 20;
        else if (k === 'ArrowLeft') code = 157;
        else if (k === 'ArrowRight') code = 29;
        else if (k === 'ArrowUp') code = 145;
        else if (k === 'ArrowDown') code = 17;
        else if (k.length === 1) code = k.toUpperCase().charCodeAt(0);
        if (code) {
            this.machine.addKey(code);
            e.preventDefault();
        }
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
        console.log(`Joystick ${port > 0 ? port : 'disabled'}`);
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

    typeText(t) {
        let z = 0;
        for (const ch of t) {
            if (ch === '\r') {
                // Normalize CR to LF handling; skip explicit processing, will be handled by LF branch
                continue;
            }
            if (ch === '\n') {
                setTimeout(() => this.handleKeyPress({
                    key: 'Enter',
                    preventDefault: () => { }
                }), z);
                z += 70; // slightly longer pause after a line
            } else {
                setTimeout(() => this.handleKeyPress({
                    key: ch,
                    preventDefault: () => { }
                }), z);
                z += 30;
            }
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
            console.log('C64 state restored');
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

        console.log('Drag-and-drop enabled for PRG and CRT files');
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
            // Load the cartridge into the machine
            const info = this.machine.loadCrt(data);
            console.log(`Loaded cartridge: ${info.name || filename}`);
            console.log(`  Type: ${info.type}, Chips: ${info.chips.length}`);

            // Reset the machine to start the cartridge
            this.machine.reset();
            console.log('Machine reset to start cartridge');
        } catch (err) {
            console.error('Failed to load CRT:', err.message);
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