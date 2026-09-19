//
// @fileoverview C64 Machine - Core hardware emulation for Turbo8bit
// @module emulator/machine
//
// This module provides the core C64 hardware emulation:
// - C64Machine: The "motherboard" with CPU, memory, and I/O mapping
// - Clock frequency constants (CLOCK_PAL, CLOCK_NTSC)
//
// For the visual emulator with canvas/audio, see emulator.js (C64Emulator).
// For SID file playback, see sid-player.js (SIDPlayer, loadSidTune).
// For PSID driver installation, see psid-driver.js.
// For SID chip emulation, see sid.js.
// For CPU emulation details, see mos6510.js.
//
// Architecture:
//   C64Machine (Bus interface)
//     ├── MOS6510 CPU (instruction-level 6502/6510 timing)
//     ├── SID chip (MOS6581/MOS8580 audio)
//     ├── 64KB RAM
//     ├── ROM mapping (BASIC $A000, KERNAL $E000)
//     └── I/O mapping (VIC-II $D000, SID $D400, CIA $DC00/$DD00)
//
// Usage:
//   import { C64Machine, CLOCK_PAL, CLOCK_NTSC } from './machine.js';
//
//   const machine = new C64Machine();
//   machine.runFrame();  // Execute one frame of emulation
//
// @see https://www.turbo8bit.com/
//

import { MOS6510, FLAG_I } from './mos6510.js';
import { SID, ChipModel, SamplingMethod } from './sid.js';
import { rom_basic, rom_kernal, rom_chars } from './roms.js';
import { Cartridge } from './cartridge.js';
import { VICIIRenderer, FRAME_BUFFER_WIDTH, FRAME_BUFFER_HEIGHT } from './vic-ii.js';

// ============================================================================
// CLOCK FREQUENCIES
// ============================================================================

// PAL C64 master clock frequency (985248 Hz)
export const CLOCK_PAL = 985248;

// NTSC C64 master clock frequency (1022727 Hz)
export const CLOCK_NTSC = 1022727;

// Timing constants
const CYCLES_PER_FRAME_PAL = 19656;   // PAL: ~50 Hz (985248 / 50.125)
const CYCLES_PER_FRAME_NTSC = 17095;  // NTSC: ~60 Hz (1022727 / 59.826)
const RASTER_TIMING_PAL = Object.freeze({
    cyclesPerLine: 63, linesPerFrame: 312, cyclesPerFrame: CYCLES_PER_FRAME_PAL
});
const RASTER_TIMING_NTSC = Object.freeze({
    cyclesPerLine: 65, linesPerFrame: 263, cyclesPerFrame: CYCLES_PER_FRAME_NTSC
});

// Memory addresses
const KEYBUF_LEN_ADDR = 0x00C6;
const KEYBUF_ADDR = 0x0277;
const RESET_VEC = 0xFFFC;

// I/O base addresses (prefixed to avoid collision with sidplayer.js in tests)
const C64_SID_BASE = 0xD400;
const C64_SID_SIZE = 32;
const C64_VIC_BASE = 0xD000;
const C64_CIA1_BASE = 0xDC00;
const C64_CIA2_BASE = 0xDD00;

//
// C64Machine - The unified C64 "motherboard"
//
// Implements the Bus interface expected by MOS6510:
// - read(addr): Read byte from memory/ROM/I/O
// - write(addr, val): Write byte to memory/I/O
//
// Integrates:
// - MOS6510 CPU with per-instruction cycle counts
// - SID sound chip
// - Memory banking (BASIC ROM, KERNAL ROM, Character ROM)
// - VIC-II video (simplified)
// - CIA1/CIA2 I/O (simplified)
//
export class C64Machine {
    constructor(options = {}) {
        // Physical RAM is distinct from the chips selected by the CPU's I/O
        // mapping. io holds hardware latches/color RAM at offsets from $D000.
        // Inspect mapped memory with peek(), or hardware with peekIO().
        this.ram = new Uint8Array(65536);
        this.io = new Uint8Array(0x1000);

        // CPU - pass 'this' as the Bus interface
        this.cpu = new MOS6510(this);

        // SID chip
        this.sid = new SID();
        this.clockFrequency = options.clockFrequency || CLOCK_PAL;
        this.sampleRate = options.sampleRate || 44100;

        // Initialize SID with default settings
        this.sid.setChipModel(options.chipModel || ChipModel.MOS6581);
        this.sid.setSamplingParameters(
            this.clockFrequency,
            SamplingMethod.DECIMATE,
            this.sampleRate
        );

        // Keyboard matrix: 8 rows (CIA1 port A) x 8 columns (CIA1 port B).
        // Bits are active LOW, so 0xFF means "no key held in this row".
        this.keyboardMatrix = new Uint8Array(8).fill(0xFF);

        // CIA1 Timer state (controls system IRQ at ~60Hz)
        this.cia1 = {
            // Timer A
            timerALatch: 0x4025,    // Timer A latch value (default ~60Hz at PAL clock)
            timerACounter: 0x4025, // Current timer countdown
            timerARunning: false,  // Timer A started (CRA bit 0)
            timerAIrqEnabled: false, // Timer A interrupt enabled (ICR bit 0)
            // Timer B
            timerBLatch: 0xFFFF,   // Timer B latch value
            timerBCounter: 0xFFFF, // Timer B current countdown
            timerBRunning: false,  // Timer B started (CRB bit 0)
            timerBIrqEnabled: false, // Timer B interrupt enabled (ICR bit 1)
            // Control registers (store full value for one-shot bit etc.)
            cra: 0,                // Control Register A
            crb: 0,                // Control Register B
            // Interrupt state
            icrData: 0,            // Interrupt flags (read clears)
            icrMask: 0             // Interrupt enable mask
        };

        // CIA2 Timer state (controls NMI for sample playback like Great Giana Sisters)
        this.cia2 = {
            // Timer A
            timerALatch: 0xFFFF,   // Timer A latch value (default max)
            timerACounter: 0xFFFF, // Current timer countdown
            timerARunning: false,  // Timer A started (CRA bit 0)
            timerANmiEnabled: false, // Timer A NMI enabled (ICR bit 0)
            // Timer B
            timerBLatch: 0xFFFF,   // Timer B latch value
            timerBCounter: 0xFFFF, // Timer B current countdown
            timerBRunning: false,  // Timer B started (CRB bit 0)
            timerBNmiEnabled: false, // Timer B NMI enabled (ICR bit 1)
            // Control registers (store full value for one-shot bit etc.)
            cra: 0,                // Control Register A
            crb: 0,                // Control Register B
            // Interrupt state
            icrData: 0,            // Interrupt flags (read clears)
            icrMask: 0,            // Interrupt enable mask
            nmiLine: true          // NMI line state (active low, true = high/inactive)
        };

        // VIC-II state (for raster interrupts and scanline rendering)
        this.vic = {
            rasterCompare: 0,      // Raster line to trigger interrupt ($D012 + $D011 bit 7)
            irqEnable: 0,          // Interrupt enable mask ($D01A)
            irqStatus: 0,          // Interrupt status flags ($D019)
            rasterCycle: 0,        // Global cycle counter for raster position
            // Frame buffer for scanline rendering - rendered during CPU execution
            // Each pixel is a packed RGB value (0xRRGGBB)
            frameBuffer: new Uint32Array(FRAME_BUFFER_WIDTH * FRAME_BUFFER_HEIGHT),
            // VICIIRenderer instance for scanline rendering
            renderer: new VICIIRenderer(FRAME_BUFFER_WIDTH, FRAME_BUFFER_HEIGHT)
        };

        // Joystick state
        // Each joystick is a byte with bits active LOW:
        // Bit 0: Up (0 = pressed)
        // Bit 1: Down
        // Bit 2: Left
        // Bit 3: Right
        // Bit 4: Fire
        // Default: 0xFF = all released
        this.joystick1 = 0xFF;  // Joystick 1 (read via CIA1 Port B $DC01)
        this.joystick2 = 0xFF;  // Joystick 2 (read via CIA1 Port A $DC00)

        // Audio state
        this.audioEnabled = options.audioEnabled !== false;
        this.cycleAccumulator = 0;
        this.audioSamplesGenerated = 0;

        // Frame timing
        this.cyclesPerFrame = options.cyclesPerFrame || this.rasterTiming.cyclesPerFrame;
        this.frameCycleStart = 0;

        // Memory banking flags (cache)
        this.isBasicOn = true;
        this.isKernalOn = true;
        this.isIOOn = true;
        this.isCharOn = false;

        // Memory Map Optimization
        // 256 pages of 256 bytes.
        // Read: 0=RAM, 1=BASIC, 2=KERNAL, 3=CHAR, 4=I/O, 5=CART_LO,
        // 6=CART_HI, 7=open bus. Write: 0=RAM, 1=I/O, 2=unmapped.
        this.readMap = new Uint8Array(256);
        this.writeMap = new Uint8Array(256);

        // Cartridge ROM (optional)
        this.cartRomL = null;  // ROML at $8000-$9FFF (8KB) - legacy
        this.cartRomH = null;  // ROMH at $A000-$BFFF or $E000-$FFFF (8KB) - legacy
        this.cartGame = true;  // /GAME line (active low, true = high/inactive)
        this.cartExrom = true; // /EXROM line (active low, true = high/inactive)

        // CRT Cartridge support (modern approach)
        this.cartridge = null; // Cartridge instance from cartridge.js

        this.reset();
    }

    get rasterTiming() {
        return this.clockFrequency === CLOCK_NTSC ? RASTER_TIMING_NTSC : RASTER_TIMING_PAL;
    }

    //
    // Reset the machine
    //
    reset() {
        this.ram.fill(0);
        this.io.fill(0);
        this.sid.reset();
        this.keyboardMatrix.fill(0xFF);
        this.audioSamplesGenerated = 0;
        this.frameCycleStart = 0;

        // Reset CIA1 timer state
        this.cia1.timerALatch = 0x4025;
        this.cia1.timerACounter = 0x4025;
        this.cia1.timerARunning = false;
        this.cia1.timerAIrqEnabled = false;
        this.cia1.timerBLatch = 0xFFFF;
        this.cia1.timerBCounter = 0xFFFF;
        this.cia1.timerBRunning = false;
        this.cia1.timerBIrqEnabled = false;
        this.cia1.cra = 0;
        this.cia1.crb = 0;
        this.cia1.icrData = 0;
        this.cia1.icrMask = 0;

        // Reset CIA2 timer state
        this.cia2.timerALatch = 0xFFFF;
        this.cia2.timerACounter = 0xFFFF;
        this.cia2.timerARunning = false;
        this.cia2.timerANmiEnabled = false;
        this.cia2.timerBLatch = 0xFFFF;
        this.cia2.timerBCounter = 0xFFFF;
        this.cia2.timerBRunning = false;
        this.cia2.timerBNmiEnabled = false;
        this.cia2.cra = 0;
        this.cia2.crb = 0;
        this.cia2.icrData = 0;
        this.cia2.icrMask = 0;
        this.cia2.nmiLine = true;  // High (inactive)

        // Reset VIC-II state
        this.vic.rasterCompare = 0;
        this.vic.irqEnable = 0;
        this.vic.irqStatus = 0;
        this.vic.lastRasterLine = -1;
        this.vic.rasterCycle = 0;
        this.vic.badLineStunned = false;
        this.vic.frameBuffer.fill(0);

        // Initialize important C64 memory locations
        // Set up some basic system vectors and initial values
        this.ram[0x0000] = 0x2F;  // Data direction register for port A
        this.ram[0x0001] = 0x07;  // Memory configuration register (RAM/ROM banking)

        // Keyboard buffer
        this.ram[0x00C6] = 0x00;  // Keyboard buffer length

        // Screen/cursor variables - let ROM initialize these
        this.ram[0x0286] = 0x0E;  // Current color (light blue)

        this.io[0x011] = 0x1B;  // YSCROLL=3, DEN=1, RSEL=1 (25 rows)
        this.io[0x016] = 0x08;  // XSCROLL=0, CSEL=1 (40 columns)
        this.io[0x020] = 0x0E;  // Border color (light blue)
        this.io[0x021] = 0x06;  // Background color (blue)

        // Initialize sprite registers
        for (let i = 0; i < 8; i++) {
            this.io[0x027 + i] = i + 1;
        }

        // Initialize sprite data pointers
        for (let i = 0; i < 8; i++) {
            this.ram[0x07F8 + i] = 0x00;
        }

        // Set up basic system vectors that KERNAL expects
        this.ram[0x0314] = 0x31;  // IRQ low byte
        this.ram[0x0315] = 0xEA;  // IRQ high byte (0xEA31)
        this.ram[0x0316] = 0x66;  // BRK vector
        this.ram[0x0317] = 0xFE;
        this.ram[0x0318] = 0x47;  // NMI vector
        this.ram[0x0319] = 0xFE;

        // Initialize CIA2 Port A ($DD00) for VIC bank selection
        // Bits 0-1 are inverted: 11 = bank 0 ($0000-$3FFF)
        // Default value also sets DDR for serial bus lines
        this.io[0xD00] = 0x03;  // VIC bank 0 (bits 0-1 = 11 inverted = 00 = bank 0)
        this.io[0xD02] = 0x3F;  // CIA2 DDRA - bits 0-5 are outputs

        // Initialize VIC-II memory pointer ($D018)
        // Default: Screen at $0400, Char ROM at $1000
        this.io[0x018] = 0x14;  // Screen at $0400, character ROM at $1000

        // Reset cartridge BEFORE CPU so reset vector comes from cartridge ROM
        if (this.cartridge) {
            this.cartridge.reset();
        }
        this.updateCartridgeMapping();

        // Reset CPU (reads reset vector from ROM or cartridge)
        this.cpu.reset();
    }

    //
    // Load a CRT cartridge from ArrayBuffer data
    // @param {ArrayBuffer} data - Raw CRT file data
    // @returns {boolean} True if loaded successfully
    //
    loadCartridge(data) {
        const cartridge = new Cartridge();
        if (!cartridge.load(data)) {
            return false;
        }

        this.cartridge = cartridge;
        this.cartRomL = null;
        this.cartRomH = null;

        // Reset machine with cartridge installed
        this.reset();
        return true;
    }

    //
    // Eject the current cartridge
    //
    ejectCartridge() {
        this.removeCartridge();
        this.reset();
    }

    //
    // Get cartridge info (if loaded)
    // @returns {Object|null} Cartridge information or null
    //
    getCartridgeInfo() {
        return this.cartridge ? this.cartridge.getInfo() : null;
    }

    // Cartridge I/O can change its lines or disable it without a CPU-port
    // write. Keep the cached PLA map coherent before the next bus access.
    updateCartridgeMapping() {
        if (this.cartridge) {
            this.cartExrom = !this.cartridge.enabled || this.cartridge.exrom === 1;
            this.cartGame = !this.cartridge.enabled || this.cartridge.game === 1;
        }
        this.updateMemoryMap();
    }

    //
    // Rebuild the PLA map from effective 6510 pins and cartridge line levels.
    // Reference: https://www.c64-wiki.com/wiki/Bank_Switching#Mode_Table
    //
    updateMemoryMap() {
        const bank = (this.ram[1] & this.ram[0]) | (0x17 & ~this.ram[0]);
        const loram = (bank & 1) !== 0;
        const hiram = (bank & 2) !== 0;
        const charen = (bank & 4) !== 0;
        const mode16K = !this.cartGame && !this.cartExrom;
        const ultimax = !this.cartGame && this.cartExrom;

        this.isBasicOn = !mode16K && !ultimax && loram && hiram;
        this.isKernalOn = !ultimax && hiram;
        this.isIOOn = ultimax || (charen && (loram || hiram));
        this.isCharOn = !ultimax && !charen && (hiram || (loram && !mode16K));

        this.readMap.fill(0);
        this.writeMap.fill(0);

        if (ultimax) {
            // Only the first 4KB of RAM is selected in Ultimax. Floating bus
            // reads are approximated as $FF; unmapped writes do not reach RAM.
            this.readMap.fill(7, 0x10, 0x80);
            this.readMap.fill(7, 0xA0, 0xD0);
            this.writeMap.fill(2, 0x10);
        }

        if (this.isBasicOn) this.readMap.fill(1, 0xA0, 0xC0);
        if (this.isKernalOn) this.readMap.fill(2, 0xE0, 0x100);

        if (this.isIOOn) {
            this.readMap.fill(4, 0xD0, 0xE0);
            this.writeMap.fill(1, 0xD0, 0xE0);
        } else if (this.isCharOn) {
            this.readMap.fill(3, 0xD0, 0xE0);
        }

        if (ultimax || (!this.cartExrom && loram && hiram)) {
            this.readMap.fill(5, 0x80, 0xA0);
        }
        if (mode16K && hiram) {
            this.readMap.fill(6, 0xA0, 0xC0);
        } else if (ultimax) {
            this.readMap.fill(6, 0xE0, 0x100);
        }
    }

    //
    // Read a byte from memory (Bus interface)
    // Implements C64 memory banking and I/O mapping
    //
    read(addr) {
        addr = addr & 0xFFFF;
        const page = addr >> 8;
        const type = this.readMap[page];

        // Optimized path: RAM (0)
        if (type === 0) {
            // Handle Port 1 (0x0001) special case
            if (addr === 1) {
                const ddr = this.ram[0];
                // Return Latch for Outputs (DDR=1), Pin level (0x17) for Inputs (DDR=0)
                return (this.ram[1] & ddr) | (0x17 & ~ddr);
            }
            return this.ram[addr];
        }

        if (type === 1) return rom_basic[addr & 0x1FFF];
        if (type === 2) return rom_kernal[addr & 0x1FFF];
        if (type === 3) return rom_chars[addr & 0x0FFF];

        if (type === 4) return this.readIO(addr);

        if (type === 5) { // CART_LO ($8000-$9FFF)
            // Check CRT cartridge first
            if (this.cartridge && this.cartridge.enabled) {
                const cartByte = this.cartridge.read(addr);
                if (cartByte !== null) return cartByte;
            }
            // Legacy cartridge support
            return this.cartRomL ? (this.cartRomL[addr & 0x1FFF] ?? 0xFF) : 0xFF;
        }

        if (type === 6) { // CART_HI ($A000-$BFFF or $E000-$FFFF)
            // Check CRT cartridge first
            if (this.cartridge && this.cartridge.enabled) {
                const cartByte = this.cartridge.read(addr);
                if (cartByte !== null) return cartByte;
            }
            // Legacy cartridge support
            return this.cartRomH ? (this.cartRomH[addr & 0x1FFF] ?? 0xFF) : 0xFF;
        }

        if (type === 7) return 0xFF;
        return this.ram[addr];
    }

    //
    // Read a byte the way the CPU would see it, but without side effects.
    //
    // Use this for anything that inspects memory for display - disassembly, hex
    // dumps, step-over detection. A real read clears the sprite collision
    // latches and the CIA interrupt registers, and can bank-switch a cartridge,
    // so showing memory to the user must not go through read().
    //
    peek(addr) {
        addr = addr & 0xFFFF;
        const type = this.readMap[addr >> 8];

        if (type === 1) return rom_basic[addr & 0x1FFF];
        if (type === 2) return rom_kernal[addr & 0x1FFF];
        if (type === 3) return rom_chars[addr & 0x0FFF];

        if (type === 4) return this.peekIO(addr);

        if (type === 5) {
            if (this.cartridge && this.cartridge.enabled) {
                const cartByte = this.cartridge.read(addr);
                if (cartByte !== null) return cartByte;
            }
            return this.cartRomL ? (this.cartRomL[addr & 0x1FFF] ?? 0xFF) : 0xFF;
        }

        if (type === 6) {
            if (this.cartridge && this.cartridge.enabled) {
                const cartByte = this.cartridge.read(addr);
                if (cartByte !== null) return cartByte;
            }
            return this.cartRomH ? (this.cartRomH[addr & 0x1FFF] ?? 0xFF) : 0xFF;
        }

        if (type === 7) return 0xFF;
        if (addr === 1) return (this.ram[1] & this.ram[0]) | (0x17 & ~this.ram[0]);
        return this.ram[addr];
    }

    //
    // Inspect hardware at $D000-$DFFF regardless of the CPU's banking.
    // Unlike read(), this never acknowledges interrupts, clears collision
    // latches, or switches cartridge banks. Register mirrors are decoded.
    //
    peekIO(addr) {
        return this.readIO(addr, false);
    }

    readIO(addr, sideEffects = true) {
        if (addr < 0xD000 || addr > 0xDFFF) throw new RangeError('I/O address out of range');
        if (addr < 0xD400) return this.readVIC(addr, sideEffects);
        if (addr < 0xD800) return sideEffects ? this.sid.read(addr & 0x1F) : this.sid.peek(addr & 0x1F);
        if (addr < 0xDC00) return this.io[addr & 0xFFF] & 0x0F;
        if (addr < 0xDD00) return this.readCIA1(addr, sideEffects);
        if (addr < 0xDE00) return this.readCIA2(addr, sideEffects);
        if (this.cartridge) {
            const value = this.cartridge.readIO(addr, sideEffects);
            if (sideEffects) this.updateCartridgeMapping();
            if (value !== null) return value;
        }
        return this.io[addr & 0xFFF];
    }

    //
    // Write a byte to memory (Bus interface)
    // Implements C64 memory banking and I/O mapping
    //
    write(addr, val) {
        addr = addr & 0xFFFF;
        val = val & 0xFF;
        const page = addr >> 8;

        // Fast path: RAM write (0)
        if (this.writeMap[page] === 0) {
            if (addr > 1) {
                this.ram[addr] = val;
                return;
            }
            // Both the data latch and DDR can change effective banking pins.
            this.ram[addr] = val;
            this.updateMemoryMap();
            return;
        }

        if (this.writeMap[page] === 1) this.writeIO(addr, val);
    }

    //
    // Configure hardware independently of CPU banking (e.g. a SID loader).
    // Emulated CPU stores must use write(), which selects I/O or underlying RAM.
    //
    writeIO(addr, val) {
        if (addr < 0xD000 || addr > 0xDFFF) throw new RangeError('I/O address out of range');
        val &= 0xFF;
        if (addr < 0xD400) {
            const reg = addr & 0x3F;
            switch (reg) {
                case 0x11:
                    this.io[reg] = val;
                    this.vic.rasterCompare = this.io[0x012] | ((val & 0x80) << 1);
                    return;
                case 0x12:
                    this.io[reg] = val;
                    this.vic.rasterCompare = ((this.io[0x011] & 0x80) << 1) | val;
                    return;
                case 0x19:
                    // Acknowledge interrupts (clear by writing 1s)
                    this.vic.irqStatus &= ~(val & 0x0F);
                    this.updateIRQLine();
                    return;
                case 0x1A:
                    this.vic.irqEnable = val & 0x0F;
                    this.io[reg] = val;
                    this.updateIRQLine();
                    return;
                case 0x1E:
                case 0x1F:
                    // Collision latches are read-only and clear only on a CPU read.
                    return;
                default:
                    this.io[reg] = val;
                    return;
            }
        }

        if (addr < 0xD800) {
            // SID write with cycle timestamp
            this.sid.write(addr & 0x1F, val, this.cpu.cycles);
            return;
        }

        if (addr < 0xDC00) {
            // Color RAM (4-bit)
            this.io[addr & 0xFFF] = val & 0x0F;
            return;
        }

        if (addr < 0xDD00) {
            this.writeCIA1(addr, val);
            return;
        }

        if (addr < 0xDE00) {
            this.writeCIA2(addr, val);
            return;
        }

        // I/O expansion area ($DE00-$DFFF) - check for cartridge first
        if (this.cartridge && this.cartridge.enabled) {
            this.cartridge.write(addr, val);
            this.updateCartridgeMapping();
        }
        this.io[addr & 0xFFF] = val;
    }

    //
    // Read from VIC-II registers
    //
    readVIC(addr, sideEffects = true) {
        // Calculate current raster line from global cycle counter
        const rasterLine = ((this.vic.rasterCycle / this.rasterTiming.cyclesPerLine) | 0);
        const reg = addr & 0x3F;

        switch (reg) {
            case 0x12:
                // Raster line counter (low 8 bits)
                return rasterLine & 0xFF;
            case 0x11:
                // Screen control + raster MSB (bit 7 = raster bit 8)
                return (this.io[reg] & 0x7F) | ((rasterLine & 0x100) >> 1);
            case 0x19:
                // Return VIC IRQ status (bit 7 set if any enabled IRQ is active)
                return this.vic.irqStatus;
            case 0x1A:
                // Interrupt enable register
                return this.vic.irqEnable;
            case 0x1E:
            case 0x1F: {
                // Sprite-sprite / sprite-background collision latches clear on read
                const collisions = this.io[reg];
                if (sideEffects) this.io[reg] = 0;
                return collisions;
            }
            default:
                return this.io[reg];
        }
    }

    //
    // Read from CIA1 registers
    // CIA1 handles keyboard, joystick, and system timer IRQ
    //
    readCIA1(addr, sideEffects = true) {
        const reg = addr & 0x0F;

        switch (reg) {
            case 0x00: {
                // Port A - keyboard row select (output) / Joystick 2 (input).
                // Pins configured as inputs float high, output pins read their
                // latch; either way a grounded switch pulls the line low.
                const paOut = this.io[0xC00] | ~this.io[0xC02];
                const pbOut = this.io[0xC01] | ~this.io[0xC03];
                let value = paOut & this.joystick2;

                // Reverse scan: a column driven low on port B pulls every row
                // that has a key held in that column low on port A.
                for (let col = 0; col < 8; col++) {
                    if (pbOut & (1 << col)) continue;
                    for (let row = 0; row < 8; row++) {
                        if (!(this.keyboardMatrix[row] & (1 << col))) {
                            value &= ~(1 << row);
                        }
                    }
                }
                return value & 0xFF;
            }

            case 0x01: {
                // Port B - keyboard column read (input) / Joystick 1
                const paOut = this.io[0xC00] | ~this.io[0xC02];
                let value = (this.io[0xC01] | ~this.io[0xC03]) & this.joystick1;

                for (let row = 0; row < 8; row++) {
                    if (paOut & (1 << row)) continue;  // row not selected
                    value &= this.keyboardMatrix[row];
                }
                return value & 0xFF;
            }

            case 0x04: // Timer A Low byte
                return this.cia1.timerACounter & 0xFF;

            case 0x05: // Timer A High byte
                return (this.cia1.timerACounter >> 8) & 0xFF;

            case 0x06: // Timer B Low byte
                return this.cia1.timerBCounter & 0xFF;

            case 0x07: // Timer B High byte
                return (this.cia1.timerBCounter >> 8) & 0xFF;

            case 0x0D: // Interrupt Control Register (ICR)
                // Reading ICR returns the interrupt flags and clears them
                // Bit 7: Set if any enabled interrupt occurred
                // Bit 0: Timer A underflow
                // Bit 1: Timer B underflow
                const icrValue = this.cia1.icrData;
                if (sideEffects) {
                    this.cia1.icrData = 0;
                    this.updateIRQLine();
                }
                return icrValue;

            case 0x0E: // Control Register A
                return this.cia1.cra;

            case 0x0F: // Control Register B
                return this.cia1.crb;

            default:
                return this.io[0xC00 + reg];
        }
    }

    //
    // Write to CIA1 registers
    //
    writeCIA1(addr, val) {
        const reg = addr & 0x0F;

        switch (reg) {
            case 0x04: // Timer A Low latch
                this.cia1.timerALatch = (this.cia1.timerALatch & 0xFF00) | val;
                break;

            case 0x05: // Timer A High latch (also loads counter if timer stopped)
                this.cia1.timerALatch = (this.cia1.timerALatch & 0x00FF) | (val << 8);
                // If timer is stopped, writing high byte loads the counter
                if (!this.cia1.timerARunning) {
                    this.cia1.timerACounter = this.cia1.timerALatch;
                }
                break;

            case 0x06: // Timer B Low latch
                this.cia1.timerBLatch = (this.cia1.timerBLatch & 0xFF00) | val;
                break;

            case 0x07: // Timer B High latch (also loads counter if timer stopped)
                this.cia1.timerBLatch = (this.cia1.timerBLatch & 0x00FF) | (val << 8);
                // If timer is stopped, writing high byte loads the counter
                if (!this.cia1.timerBRunning) {
                    this.cia1.timerBCounter = this.cia1.timerBLatch;
                }
                break;

            case 0x0D: // Interrupt Control Register (ICR)
                // Bit 7: 1 = set bits, 0 = clear bits
                // Bit 0: Timer A interrupt enable
                // Bit 1: Timer B interrupt enable
                if (val & 0x80) {
                    // Set bits
                    this.cia1.icrMask |= (val & 0x1F);
                } else {
                    // Clear bits
                    this.cia1.icrMask &= ~(val & 0x1F);
                }
                this.cia1.timerAIrqEnabled = (this.cia1.icrMask & 0x01) !== 0;
                this.cia1.timerBIrqEnabled = (this.cia1.icrMask & 0x02) !== 0;
                if (this.cia1.icrData & this.cia1.icrMask & 0x03) {
                    this.cia1.icrData |= 0x80;
                }
                this.updateIRQLine();
                break;

            case 0x0E: // Control Register A
                // Bit 0: Start/stop timer
                // Bit 3: One-shot (1) or continuous (0) mode
                // Bit 4: Force load
                this.cia1.cra = val & ~0x10; // Store all bits except force-load (strobe)
                this.cia1.timerARunning = (val & 0x01) !== 0;
                if (val & 0x10) {
                    // Force load latch into counter
                    this.cia1.timerACounter = this.cia1.timerALatch;
                }
                break;

            case 0x0F: // Control Register B
                // Bit 0: Start/stop timer
                // Bit 3: One-shot (1) or continuous (0) mode
                // Bit 4: Force load
                // Bits 5-6: Timer B input mode (00=system clock, 01=CNT, 10=Timer A underflow, 11=Timer A underflow while CNT high)
                this.cia1.crb = val & ~0x10; // Store all bits except force-load (strobe)
                this.cia1.timerBRunning = (val & 0x01) !== 0;
                if (val & 0x10) {
                    // Force load latch into counter
                    this.cia1.timerBCounter = this.cia1.timerBLatch;
                }
                break;

            default:
                this.io[0xC00 + reg] = val;
        }
    }

    //
    // Read from CIA2 registers
    // CIA2 handles VIC bank selection and NMI timer
    //
    readCIA2(addr, sideEffects = true) {
        const reg = addr & 0x0F;

        switch (reg) {
            case 0x00: // Port A - VIC bank selection
                return (this.io[0xD00] | ~this.io[0xD02]) & 0xFF;

            case 0x04: // Timer A Low byte
                return this.cia2.timerACounter & 0xFF;

            case 0x05: // Timer A High byte
                return (this.cia2.timerACounter >> 8) & 0xFF;

            case 0x06: // Timer B Low byte
                return this.cia2.timerBCounter & 0xFF;

            case 0x07: // Timer B High byte
                return (this.cia2.timerBCounter >> 8) & 0xFF;

            case 0x0D: // Interrupt Control Register (ICR)
                // Reading ICR returns the interrupt flags and clears them
                // Bit 7: Set if any enabled interrupt occurred
                // Bit 0: Timer A underflow
                // Bit 1: Timer B underflow
                const icrValue = this.cia2.icrData;
                if (sideEffects) {
                    this.cia2.icrData = 0;
                    this.updateNMI();
                }
                return icrValue;

            case 0x0E: // Control Register A
                return this.cia2.cra;

            case 0x0F: // Control Register B
                return this.cia2.crb;

            default:
                return this.io[0xD00 + reg];
        }
    }

    //
    // Write to CIA2 registers
    //
    writeCIA2(addr, val) {
        const reg = addr & 0x0F;

        switch (reg) {
            case 0x00: // Port A - VIC bank selection
                this.io[0xD00] = val;
                break;

            case 0x04: // Timer A Low latch
                this.cia2.timerALatch = (this.cia2.timerALatch & 0xFF00) | val;
                break;

            case 0x05: // Timer A High latch (also loads counter if timer stopped)
                this.cia2.timerALatch = (this.cia2.timerALatch & 0x00FF) | (val << 8);
                // If timer is stopped, writing high byte loads the counter
                if (!this.cia2.timerARunning) {
                    this.cia2.timerACounter = this.cia2.timerALatch;
                }
                break;

            case 0x06: // Timer B Low latch
                this.cia2.timerBLatch = (this.cia2.timerBLatch & 0xFF00) | val;
                break;

            case 0x07: // Timer B High latch (also loads counter if timer stopped)
                this.cia2.timerBLatch = (this.cia2.timerBLatch & 0x00FF) | (val << 8);
                // If timer is stopped, writing high byte loads the counter
                if (!this.cia2.timerBRunning) {
                    this.cia2.timerBCounter = this.cia2.timerBLatch;
                }
                break;

            case 0x0D: // Interrupt Control Register (ICR)
                // Bit 7: 1 = set bits, 0 = clear bits
                // Bit 0: Timer A NMI enable
                // Bit 1: Timer B NMI enable
                if (val & 0x80) {
                    // Set bits
                    this.cia2.icrMask |= (val & 0x1F);
                } else {
                    // Clear bits
                    this.cia2.icrMask &= ~(val & 0x1F);
                }
                this.cia2.timerANmiEnabled = (this.cia2.icrMask & 0x01) !== 0;
                this.cia2.timerBNmiEnabled = (this.cia2.icrMask & 0x02) !== 0;
                // Update NMI line state immediately
                this.updateNMI();
                break;

            case 0x0E: // Control Register A
                // Bit 0: Start/stop timer
                // Bit 3: One-shot (1) or continuous (0) mode
                // Bit 4: Force load
                this.cia2.cra = val & ~0x10; // Store all bits except force-load (strobe)
                this.cia2.timerARunning = (val & 0x01) !== 0;
                if (val & 0x10) {
                    // Force load latch into counter
                    this.cia2.timerACounter = this.cia2.timerALatch;
                }
                break;

            case 0x0F: // Control Register B
                // Bit 0: Start/stop timer
                // Bit 3: One-shot (1) or continuous (0) mode
                // Bit 4: Force load
                // Bits 5-6: Timer B input mode (00=system clock, 01=CNT, 10=Timer A underflow, 11=Timer A underflow while CNT high)
                this.cia2.crb = val & ~0x10; // Store all bits except force-load (strobe)
                this.cia2.timerBRunning = (val & 0x01) !== 0;
                if (val & 0x10) {
                    // Force load latch into counter
                    this.cia2.timerBCounter = this.cia2.timerBLatch;
                }
                break;

            default:
                this.io[0xD00 + reg] = val;
        }
    }

    //
    // Update NMI line state and trigger NMI on falling edge
    // NMI is edge-triggered (high-to-low transition)
    //
    updateNMI() {
        // NMI is active when interrupt occurred AND NMI is enabled for that source
        const nmiActive = (this.cia2.icrData & this.cia2.icrMask & 0x03) !== 0;
        if (nmiActive) this.cia2.icrData |= 0x80;

        if (nmiActive && this.cia2.nmiLine) {
            // High to low transition - trigger NMI
            this.cia2.nmiLine = false;
            this.cpu.triggerNMI();
        } else if (!nmiActive) {
            // Release NMI line
            this.cia2.nmiLine = true;
        }
    }

    //
    // Update IRQ line state based on all IRQ sources
    // IRQ is level-triggered - CPU sees IRQ as long as any source is active
    //
    updateIRQLine() {
        const vicIRQ = (this.vic.irqStatus & this.vic.irqEnable & 0x0F) !== 0;
        this.vic.irqStatus = (this.vic.irqStatus & 0x0F) | (vicIRQ ? 0x80 : 0);
        const ciaIRQ = (this.cia1.icrData & 0x80) !== 0;

        if (vicIRQ || ciaIRQ) {
            this.cpu.triggerIRQ();
        } else {
            this.cpu.clearIRQ();
        }
    }

    //
    // Tick a CIA timer and handle underflow
    // @param {Object} cia - CIA state object (this.cia1 or this.cia2)
    // @param {string} timer - 'A' or 'B'
    // @param {number} cycles - Number of cycles to tick
    // @param {Function} triggerInterrupt - Function to call when interrupt fires
    // @returns {number} Underflow count (Timer B may count these rather than phi2)
    //
    tickCIATimer(cia, timer, cycles, triggerInterrupt) {
        const isTimerA = timer === 'A';
        const counterKey = isTimerA ? 'timerACounter' : 'timerBCounter';
        const latchKey = isTimerA ? 'timerALatch' : 'timerBLatch';
        const runningKey = isTimerA ? 'timerARunning' : 'timerBRunning';
        const crKey = isTimerA ? 'cra' : 'crb';
        const irqFlag = isTimerA ? 0x01 : 0x02;
        const irqEnabledKey = isTimerA ?
            (cia === this.cia1 ? 'timerAIrqEnabled' : 'timerANmiEnabled') :
            (cia === this.cia1 ? 'timerBIrqEnabled' : 'timerBNmiEnabled');

        cia[counterKey] -= cycles;

        if (cia[counterKey] < 0) {
            // A timer counts through zero. Account for every reload when a
            // whole instruction or Bad Line stall crosses several periods.
            const period = cia[latchKey] + 1;
            let underflows = Math.ceil(-cia[counterKey] / period);
            cia[counterKey] += underflows * period;

            // Set timer interrupt flag
            cia.icrData |= irqFlag;

            // One-shot mode: stop timer after underflow (CR bit 3)
            if (cia[crKey] & 0x08) {
                underflows = 1;
                cia[counterKey] = cia[latchKey];
                cia[runningKey] = false;
                cia[crKey] &= ~0x01; // Clear start bit
            }

            // Trigger interrupt if enabled
            if (cia[irqEnabledKey]) {
                cia.icrData |= 0x80; // Set "interrupt occurred" flag
                triggerInterrupt();
            }

            return underflows;
        }
        return 0;
    }

    //
    // Tick Timer B when it's counting Timer A underflows
    // @param {Object} cia - CIA state object
    // @param {Function} triggerInterrupt - Function to call when interrupt fires
    //
    tickCIATimerBFromA(cia, triggerInterrupt, underflows = 1) {
        return this.tickCIATimer(cia, 'B', underflows, triggerInterrupt);
    }

    //
    // Add a key to the keyboard buffer
    //
    addKey(petscii) {
        const len = this.ram[KEYBUF_LEN_ADDR];
        if (len < 10) {
            this.ram[KEYBUF_ADDR + len] = petscii & 0xFF;
            this.ram[KEYBUF_LEN_ADDR] = len + 1;
        }
    }

    //
    // Press or release a key in the C64 keyboard matrix
    //
    // This is the physical-key path: the KERNAL's scan routine sees the matrix
    // and converts it to PETSCII itself, so shifted characters, key repeat and
    // direct matrix reads by games all behave as they do on real hardware.
    // For synthetic typing that should bypass the scan, use addKey() instead.
    //
    // @param {number} row - Matrix row 0-7 (CIA1 port A line)
    // @param {number} col - Matrix column 0-7 (CIA1 port B line)
    // @param {boolean} pressed - True to press, false to release
    //
    setKey(row, col, pressed) {
        if (row < 0 || row > 7 || col < 0 || col > 7) return;
        if (pressed) {
            this.keyboardMatrix[row] &= ~(1 << col);
        } else {
            this.keyboardMatrix[row] |= (1 << col);
        }
    }

    //
    // Release every key in the matrix. Used when the page loses focus, so keys
    // held at that moment do not stick down.
    //
    releaseAllKeys() {
        this.keyboardMatrix.fill(0xFF);
    }

    //
    // Press the RUN/STOP key (matrix row 7, column 7) for a short moment
    //
    pressStop() {
        this.setKey(7, 7, true);
        setTimeout(() => this.setKey(7, 7, false), 150);
    }

    //
    // Set joystick state
    // @param {number} port - Joystick port (1 or 2)
    // @param {Object} state - Joystick state { up, down, left, right, fire }
    //
    // Each direction/button is a boolean (true = pressed)
    // Joystick bits are active LOW in the hardware
    //
    setJoystick(port, state) {
        // Build the joystick byte (active LOW)
        // Bit 0: Up
        // Bit 1: Down
        // Bit 2: Left
        // Bit 3: Right
        // Bit 4: Fire
        let value = 0xFF;
        if (state.up) value &= ~0x01;
        if (state.down) value &= ~0x02;
        if (state.left) value &= ~0x04;
        if (state.right) value &= ~0x08;
        if (state.fire) value &= ~0x10;

        if (port === 1) {
            this.joystick1 = value;
        } else if (port === 2) {
            this.joystick2 = value;
        }
    }

    //
    // Press a single joystick direction or fire button
    // @param {number} port - Joystick port (1 or 2)
    // @param {string} button - Button name: 'up', 'down', 'left', 'right', 'fire'
    // @param {boolean} pressed - True if pressed, false if released
    //
    setJoystickButton(port, button, pressed) {
        const bitMask = {
            up: 0x01,
            down: 0x02,
            left: 0x04,
            right: 0x08,
            fire: 0x10
        };

        const mask = bitMask[button];
        if (!mask) return;

        const joy = port === 1 ? 'joystick1' : 'joystick2';
        if (pressed) {
            this[joy] &= ~mask;  // Active LOW: clear bit to press
        } else {
            this[joy] |= mask;   // Set bit to release
        }
    }

    //
    // Execute a single CPU instruction and update VIC-II timing
    // Returns the number of cycles executed
    // This is useful for debugging/testing where you want to step
    // through code while keeping the raster position accurate
    //
    step() {
        const stepCycles = this.cpu.step();
        
        // Update VIC-II raster position
        this.vic.rasterCycle += stepCycles;
        const cyclesPerFullFrame = this.rasterTiming.cyclesPerFrame;
        if (this.vic.rasterCycle >= cyclesPerFullFrame) {
            this.vic.rasterCycle -= cyclesPerFullFrame;
        }
        
        return stepCycles;
    }

    //
    // Execute CPU cycles and generate audio samples
    // Returns the number of cycles executed
    //
    runFrame(audioBuffer = null) {
        const startCycles = this.cpu.cycles;
        this.frameCycleStart = startCycles;

        // Begin new audio frame
        if (this.audioEnabled) {
            this.sid.beginFrame();
        } else {
            // Nothing will clock the SID this frame, so retire any queued
            // register writes now. Otherwise the queue grows without bound.
            this.sid.applyPendingWrites();
        }

        // Audio interleaving state
        let audioBufferIndex = 0;
        let lastSidClockCycles = 0;

        // Cache state for faster access
        const cia1 = this.cia1;
        const cia2 = this.cia2;
        const vic = this.vic;
        const cpu = this.cpu;
        const { cyclesPerLine: cyclesPerRasterLine, cyclesPerFrame: cyclesPerFullFrame } = this.rasterTiming;
        const updateIRQ = () => this.updateIRQLine();
        const updateNMI = () => this.updateNMI();

        let cyclesExecuted = 0;
        // CPU execution and VIC bus steals consume the same chip time.
        // Whole instructions and flat 40-cycle steals remain the timing unit.
        const advanceHardware = (cycles) => {
            cyclesExecuted += cycles;

            // Tick CIA1 Timer A
            if (cia1.timerARunning && !(cia1.cra & 0x20)) {
                const underflows = this.tickCIATimer(cia1, 'A', cycles, updateIRQ);
                // Check if Timer B is counting Timer A underflows (CRB bits 5-6 = 10 or 11)
                if (underflows && cia1.timerBRunning && ((cia1.crb & 0x60) >= 0x40)) {
                    this.tickCIATimerBFromA(cia1, updateIRQ, underflows);
                }
            }

            // Tick CIA1 Timer B (when counting system clock - CRB bits 5-6 = 00)
            if (cia1.timerBRunning && ((cia1.crb & 0x60) === 0x00)) {
                this.tickCIATimer(cia1, 'B', cycles, updateIRQ);
            }

            // Tick CIA2 Timer A (NMI timer for sample playback)
            if (cia2.timerARunning && !(cia2.cra & 0x20)) {
                const underflows = this.tickCIATimer(cia2, 'A', cycles, updateNMI);
                // Check if Timer B is counting Timer A underflows (CRB bits 5-6 = 10 or 11)
                if (underflows && cia2.timerBRunning && ((cia2.crb & 0x60) >= 0x40)) {
                    this.tickCIATimerBFromA(cia2, updateNMI, underflows);
                }
            }

            // Tick CIA2 Timer B (when counting system clock - CRB bits 5-6 = 00)
            if (cia2.timerBRunning && ((cia2.crb & 0x60) === 0x00)) {
                this.tickCIATimer(cia2, 'B', cycles, updateNMI);
            }

            vic.rasterCycle += cycles;

            if (vic.rasterCycle >= cyclesPerFullFrame) {
                vic.rasterCycle -= cyclesPerFullFrame;
            }
            const currentRasterLine = ((vic.rasterCycle / cyclesPerRasterLine) | 0);

            // Detect raster line change and check for match
            if (currentRasterLine !== vic.lastRasterLine) {
                // Render the PREVIOUS scanline now that we've completed it
                // This gives raster IRQ handlers ~63 cycles to update VIC registers
                // before we capture the graphics state for that line.
                // Critical for split-screen effects (e.g., River Raid status bar)
                if (vic.lastRasterLine >= 0) {
                    vic.renderer.renderScanline(vic.frameBuffer, this, vic.lastRasterLine);
                }

                // Reset Bad Line stun flag for new line
                vic.badLineStunned = false;

                // Trigger raster IRQ for the NEW line
                if (currentRasterLine === vic.rasterCompare) {
                    // Set raster IRQ flag (bit 0) in VIC status
                    vic.irqStatus |= 0x01;

                    // If raster IRQ is enabled, set "any IRQ" bit
                    if (vic.irqEnable & 0x01) {
                        vic.irqStatus |= 0x80;
                    }
                    // Update combined IRQ line state
                    this.updateIRQLine();
                }

                vic.lastRasterLine = currentRasterLine;

                // Interleave SID clocking (every scanline)
                if (audioBuffer && this.audioEnabled) {
                    const currentCycles = cyclesExecuted;
                    const cyclesSinceLast = currentCycles - lastSidClockCycles;
                    if (cyclesSinceLast > 0) {
                        // Create a view into the buffer at the current position
                        const targetBuf = audioBuffer.subarray(audioBufferIndex);
                        const samples = this.sid.clock(cyclesSinceLast, targetBuf, this.frameCycleStart + lastSidClockCycles);
                        audioBufferIndex += samples;
                        lastSidClockCycles = currentCycles;
                    }
                }
            }
        };

        // Retain raster position and partial-line state across frame budgets.
        // Resetting them here would discard instruction overshoot every frame.
        advanceHardware(0);
        while (cyclesExecuted < this.cyclesPerFrame) {
            if (cpu.halted) break;
            const rasterLine = (vic.rasterCycle / cyclesPerRasterLine) | 0;
            if (!vic.badLineStunned && vic.renderer.checkBadLine(this, rasterLine)) {
                const stunCycles = 40;
                vic.badLineStunned = true;
                cpu.cycles += stunCycles;
                advanceHardware(stunCycles);
            } else {
                advanceHardware(cpu.step());
            }
        }

        // Render the final scanline of the frame (since we render the previous line on transition)
        if (vic.lastRasterLine >= 0) {
            vic.renderer.renderScanline(vic.frameBuffer, this, vic.lastRasterLine);
        }

        // Generate remaining audio samples
        if (audioBuffer && this.audioEnabled) {
            const currentCycles = cyclesExecuted;
            const cyclesSinceLast = currentCycles - lastSidClockCycles;
            if (cyclesSinceLast > 0) {
                const targetBuf = audioBuffer.subarray(audioBufferIndex);
                audioBufferIndex += this.sid.clock(cyclesSinceLast, targetBuf, this.frameCycleStart + lastSidClockCycles);
            }
        }

        // Number of audio samples written into audioBuffer by this frame.
        this.audioSamplesGenerated = audioBufferIndex;

        return cyclesExecuted;
    }

    //
    // Clock the SID and generate audio samples (Int16 output)
    // Uses the correct start cycle from the last frame for proper write timing
    //
    generateAudio(buffer) {
        if (!this.audioEnabled) {
            buffer.fill(0);
            return buffer.length;
        }
        return this.sid.clock(this.cyclesPerFrame, buffer, this.frameCycleStart);
    }

    //
    // Load code into RAM at specified address
    // This is a generic method for loading PRG files, PSID drivers, or any binary data.
    // It writes physical RAM, including beneath ROM/I/O, without touching chips.
    //
    // @param {Uint8Array|Array} data - The binary data to load
    // @param {number} address - The starting address in RAM
    //
    loadCode(data, address) {
        for (let i = 0; i < data.length; i++) {
            this.ram[address + i] = data[i];
        }
    }

    //
    // Load a PRG file (first 2 bytes are load address, little-endian)
    //
    // @param {Uint8Array|Array} data - The PRG file data including the 2-byte header
    // @returns {number} The load address
    //
    loadPrg(data) {
        const loadAddress = data[0] | (data[1] << 8);
        this.loadCode(data.slice(2), loadAddress);
        return loadAddress;
    }

    //
    // Legacy typed-array loader: install without resetting the running machine.
    // Use the same parser and mapping as loadCartridge(), which also cold-boots.
    //
    // @param {Uint8Array} data - The CRT file data
    // @returns {object} Cartridge info (name, type, chips loaded)
    //
    loadCrt(data) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        const cartridge = new Cartridge();
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        if (!cartridge.load(buffer)) {
            throw new Error('Invalid CRT file');
        }
        this.cartridge = cartridge;
        this.cartRomL = null;
        this.cartRomH = null;
        this.updateCartridgeMapping();
        return {
            name: cartridge.name,
            type: cartridge.hardwareType,
            exrom: cartridge.exrom,
            game: cartridge.game,
            chips: cartridge.banks.map(bank => ({
                type: bank.type, bank: bank.bankNumber, loadAddr: bank.loadAddress, size: bank.size
            }))
        };
    }

    //
    // Remove the currently loaded cartridge
    //
    removeCartridge() {
        if (this.cartridge) this.cartridge.eject();
        this.cartridge = null;
        this.cartRomL = null;
        this.cartRomH = null;
        this.cartGame = true;
        this.cartExrom = true;
        this.updateMemoryMap();
    }
}
