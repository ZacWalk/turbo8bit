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
//     ├── MOS6510 CPU (cycle-exact 6502/6510)
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
import { VICIIRenderer, FRAME_BUFFER_WIDTH, FRAME_BUFFER_HEIGHT, FIRST_VISIBLE_RASTER, VISIBLE_RASTER_LINES, VIC_CTRL1, VIC_CTRL2 } from './vic-ii.js';

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
const CYCLES_PER_FRAME = CYCLES_PER_FRAME_PAL;

// VIC-II raster timing (PAL)
const CYCLES_PER_RASTER_LINE = 63;    // CPU cycles per raster line
const RASTER_LINES_PER_FRAME = 312;   // Total raster lines (PAL)

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
// - MOS6510 cycle-exact CPU
// - SID sound chip
// - Memory banking (BASIC ROM, KERNAL ROM, Character ROM)
// - VIC-II video (simplified)
// - CIA1/CIA2 I/O (simplified)
//
export class C64Machine {
    constructor(options = {}) {
        // RAM (64KB)
        this.ram = new Uint8Array(65536);

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

        // I/O state
        this.stopKeyPressed = false;

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

        // Frame timing
        this.cyclesPerFrame = options.cyclesPerFrame || CYCLES_PER_FRAME;
        this.frameCycleStart = 0;

        // Memory banking flags (cache)
        this.isBasicOn = true;
        this.isKernalOn = true;
        this.isIOOn = true;
        this.isCharOn = false;

        // Memory Map Optimization
        // 256 pages of 256 bytes.
        // Each entry is: 0=RAM, 1=BASIC, 2=KERNAL, 3=CHAR, 4=I/O, 5=CART_LO, 6=CART_HI
        this.readMap = new Uint8Array(256);
        this.writeMap = new Uint8Array(256); // Mostly 0 (RAM), 1 for I/O

        // Cartridge ROM (optional)
        this.cartRomL = null;  // ROML at $8000-$9FFF (8KB) - legacy
        this.cartRomH = null;  // ROMH at $A000-$BFFF or $E000-$FFFF (8KB) - legacy
        this.cartGame = true;  // /GAME line (active low, true = high/inactive)
        this.cartExrom = true; // /EXROM line (active low, true = high/inactive)

        // CRT Cartridge support (modern approach)
        this.cartridge = null; // Cartridge instance from cartridge.js

        this.reset();
    }

    //
    // Reset the machine
    //
    reset() {
        this.ram.fill(0);
        this.sid.reset();

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

        console.log('Machine reset - clearing RAM and resetting CPU');

        // Initialize important C64 memory locations
        // Set up some basic system vectors and initial values
        this.ram[0x0000] = 0x2F;  // Data direction register for port A
        this.ram[0x0001] = 0x07;  // Memory configuration register (RAM/ROM banking)
        this.updateMemoryMap();   // Initialize banking flags

        // Keyboard buffer
        this.ram[0x00C6] = 0x00;  // Keyboard buffer length

        // Screen/cursor variables - let ROM initialize these
        this.ram[0x0286] = 0x0E;  // Current color (light blue)

        // VIC-II registers (would normally be at 0xD000-0xD3FF)
        this.ram[VIC_CTRL1] = 0x1B;  // Control register 1: YSCROLL=3, DEN=1, RSEL=1 (25 rows)
        this.ram[VIC_CTRL2] = 0x08;  // Control register 2: XSCROLL=0, CSEL=1 (40 columns)
        this.ram[0xD020] = 0x0E;  // Border color (light blue)
        this.ram[0xD021] = 0x06;  // Background color (blue)

        // Initialize sprite registers
        this.ram[0xD015] = 0x00;  // Sprite enable register (all disabled)
        this.ram[0xD010] = 0x00;  // Sprites 0-7 X position MSB
        this.ram[0xD017] = 0x00;  // Sprites 0-7 Y expand
        this.ram[0xD01C] = 0x00;  // Sprites 0-7 multicolor mode
        this.ram[0xD01D] = 0x00;  // Sprites 0-7 X expand
        this.ram[0xD025] = 0x00;  // Sprite multicolor register 0
        this.ram[0xD026] = 0x00;  // Sprite multicolor register 1

        // Initialize sprite colors (0xD027-0xD02E)
        for (let i = 0; i < 8; i++) {
            this.ram[0xD027 + i] = i + 1;
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
        this.ram[0xDD00] = 0x03;  // VIC bank 0 (bits 0-1 = 11 inverted = 00 = bank 0)
        this.ram[0xDD02] = 0x3F;  // CIA2 DDRA - bits 0-5 are outputs

        // Initialize VIC-II memory pointer ($D018)
        // Default: Screen at $0400, Char ROM at $1000
        this.ram[0xD018] = 0x14;  // Screen at $0400 (bits 4-7 = 1), Char at $1000 (bits 1-3 = 2)

        // Reset cartridge BEFORE CPU so reset vector comes from cartridge ROM
        if (this.cartridge) {
            this.cartridge.reset();
            this.cartExrom = this.cartridge.exrom === 1;
            this.cartGame = this.cartridge.game === 1;
        }

        // Reset CPU (reads reset vector from ROM or cartridge)
        this.cpu.reset();

        console.log(`CPU PC set to: 0x${this.cpu.PC.toString(16).padStart(4, '0')}`);
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
        this.cartExrom = cartridge.exrom === 1;
        this.cartGame = cartridge.game === 1;

        console.log(`Cartridge loaded: ${cartridge.name}`);
        console.log(`  Type: ${cartridge.getInfo().typeName}`);
        console.log(`  Banks: ${cartridge.banks.length}`);
        console.log(`  Size: ${cartridge.getInfo().totalSize} bytes`);

        // Reset machine with cartridge installed
        this.reset();
        return true;
    }

    //
    // Eject the current cartridge
    //
    ejectCartridge() {
        if (this.cartridge) {
            this.cartridge.eject();
            this.cartridge = null;
        }
        this.cartExrom = true;
        this.cartGame = true;
        this.cartRomL = null;
        this.cartRomH = null;

        console.log('Cartridge ejected');
        this.reset();
    }

    //
    // Get cartridge info (if loaded)
    // @returns {Object|null} Cartridge information or null
    //
    getCartridgeInfo() {
        return this.cartridge ? this.cartridge.getInfo() : null;
    }

    //
    // Update memory banking flags based on $0001
    //
    updateMemoryMap() {
        const bank = this.ram[1];
        // Bit 0 (LORAM): BASIC ROM at $A000-$BFFF
        // Bit 1 (HIRAM): KERNAL ROM at $E000-$FFFF
        // Bit 2 (CHAREN): 0=Char ROM, 1=I/O at $D000-$DFFF

        this.isBasicOn = (bank & 3) === 3;
        this.isKernalOn = (bank & 2) !== 0;
        this.isIOOn = (bank & 4) !== 0 && (bank & 3) !== 0;
        this.isCharOn = (bank & 4) === 0 && (bank & 3) !== 0;

        // Update Page Tables
        // 1. Default all to RAM (0)
        this.readMap.fill(0);

        // 2. Map ROMs
        if (this.isBasicOn) this.readMap.fill(1, 0xA0, 0xC0); // 0xA000 - 0xBFFF
        if (this.isKernalOn) this.readMap.fill(2, 0xE0, 0x100); // 0xE000 - 0xFFFF

        // 3. Map I/O & Char
        if (this.isIOOn) {
            this.readMap.fill(4, 0xD0, 0xE0); // I/O
            this.writeMap.fill(1, 0xD0, 0xE0); // I/O writes
        } else {
            this.writeMap.fill(0, 0xD0, 0xE0); // RAM writes
            if (this.isCharOn) {
                this.readMap.fill(3, 0xD0, 0xE0); // Char ROM
            }
        }

        // 4. Cartridge overrides (Legacy & CRT)
        // Check for CRT cartridge first (modern approach), then legacy
        const hasRomL = this.cartRomL || (this.cartridge && this.cartridge.enabled && this.cartridge.romlBank);
        const hasRomH = this.cartRomH || (this.cartridge && this.cartridge.enabled && this.cartridge.romhBank);

        // ROML mapping: When EXROM=0, ROML appears at $8000-$9FFF
        // cartExrom is true when EXROM line is HIGH (inactive), false when LOW (active)
        if (hasRomL && !this.cartExrom) {
            this.readMap.fill(5, 0x80, 0xA0); // $8000-$9FFF
        }

        // ROMH mapping depends on mode:
        // - 16K mode (EXROM=0, GAME=0): ROMH at $A000-$BFFF, replaces BASIC ROM
        // - Ultimax mode (EXROM=1, GAME=0): ROMH at $E000-$FFFF, replaces KERNAL ROM
        // cartGame is true when GAME line is HIGH (inactive), false when LOW (active)
        if (hasRomH) {
            if (!this.cartGame && !this.cartExrom) {
                // 16K mode: ROMH at $A000-$BFFF
                this.readMap.fill(6, 0xA0, 0xC0);
            } else if (!this.cartGame && this.cartExrom) {
                // Ultimax mode: ROMH at $E000-$FFFF
                this.readMap.fill(6, 0xE0, 0x100);
            }
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

        if (type === 4) { // I/O
            // I/O area - use cascading checks (ordered by frequency/address)
            if (addr < 0xD400) return this.readVIC(addr);
            if (addr < 0xD800) return this.sid.read(addr & 0x1F);
            if (addr < 0xDC00) return this.ram[addr] & 0x0F;  // Color RAM
            if (addr < 0xDD00) return this.readCIA1(addr);
            if (addr < 0xDE00) return this.readCIA2(addr);
            // I/O expansion ($DE00-$DFFF) - check cartridge for bank switching
            if (this.cartridge && this.cartridge.enabled) {
                const cartResult = this.cartridge.readIO(addr);
                // Update local EXROM/GAME lines from cartridge
                this.cartExrom = this.cartridge.exrom === 1;
                this.cartGame = this.cartridge.game === 1;
                if (cartResult !== null) return cartResult;
            }
            return this.ram[addr];
        }

        if (type === 5) { // CART_LO ($8000-$9FFF)
            // Check CRT cartridge first
            if (this.cartridge && this.cartridge.enabled) {
                const cartByte = this.cartridge.read(addr);
                if (cartByte !== null) return cartByte;
            }
            // Legacy cartridge support
            return this.cartRomL ? this.cartRomL[addr & 0x1FFF] : this.ram[addr];
        }

        if (type === 6) { // CART_HI ($A000-$BFFF or $E000-$FFFF)
            // Check CRT cartridge first
            if (this.cartridge && this.cartridge.enabled) {
                const cartByte = this.cartridge.read(addr);
                if (cartByte !== null) return cartByte;
            }
            // Legacy cartridge support
            return this.cartRomH ? this.cartRomH[addr & 0x1FFF] : this.ram[addr];
        }

        return this.ram[addr];
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
            if (addr === 0) {
                this.ram[0] = val;
                return;
            }
            // addr === 1: Only output bits (DDR=1) can be written
            // But we store the full value in the latch (ram[1])
            this.ram[1] = val;
            this.updateMemoryMap();
            return;
        }

        // I/O Write (type === 1)
        // $D000-$DFFF: Check if I/O is visible

        // I/O visible when CHAREN=1 (bit 2) AND (HIRAM=1 OR LORAM=1)
        // i.e., (bank & 4) !== 0 AND (bank & 3) !== 0
        if (!this.isIOOn) {
            this.ram[addr] = val;
            return;
        }

        // I/O writes - route by sub-range
        if (addr < 0xD400) {
            // VIC-II - handle special registers inline for speed
            switch (addr) {
                case VIC_CTRL1:
                    this.ram[addr] = val;
                    this.vic.rasterCompare = (this.ram[0xD012] & 0xFF) | ((val & 0x80) << 1);
                    return;
                case 0xD012:
                    this.ram[addr] = val;
                    this.vic.rasterCompare = ((this.ram[VIC_CTRL1] & 0x80) << 1) | val;
                    return;
                case 0xD019:
                    // Acknowledge interrupts (clear by writing 1s)
                    this.vic.irqStatus &= ~(val & 0x0F);
                    if ((this.vic.irqStatus & 0x0F) === 0) this.vic.irqStatus &= 0x7F;
                    this.ram[addr] = this.vic.irqStatus;
                    this.updateIRQLine();
                    return;
                case 0xD01A:
                    this.vic.irqEnable = val & 0x0F;
                    this.ram[addr] = val;
                    return;
                case 0xD020:
                case 0xD021:
                    // Border/background color - just store, color captured at raster line start
                    this.ram[addr] = val;
                    return;
                default:
                    this.ram[addr] = val;
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
            this.ram[addr] = val & 0x0F;
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
            // Update local EXROM/GAME lines from cartridge
            this.cartExrom = this.cartridge.exrom === 1;
            this.cartGame = this.cartridge.game === 1;
        }
        this.ram[addr] = val;
    }

    //
    // Read from VIC-II registers
    //
    readVIC(addr) {
        // Calculate current raster line from global cycle counter
        const rasterLine = ((this.vic.rasterCycle / CYCLES_PER_RASTER_LINE) | 0);

        switch (addr) {
            case 0xD012:
                // Raster line counter (low 8 bits)
                return rasterLine & 0xFF;
            case VIC_CTRL1:
                // Screen control + raster MSB (bit 7 = raster bit 8)
                return (this.ram[addr] & 0x7F) | ((rasterLine & 0x100) >> 1);
            case 0xD019:
                // Return VIC IRQ status (bit 7 set if any enabled IRQ is active)
                return this.vic.irqStatus;
            case 0xD01A:
                // Interrupt enable register
                return this.vic.irqEnable;
            default:
                return this.ram[addr];
        }
    }

    //
    // Read from CIA1 registers
    // CIA1 handles keyboard, joystick, and system timer IRQ
    //
    readCIA1(addr) {
        const reg = addr & 0x0F;

        switch (reg) {
            case 0x00: // Port A - Keyboard row select / Joystick 2
                // When reading, return joystick 2 state ANDed with keyboard row select
                // Games typically write to PRA to select keyboard rows, then read PRB
                return this.joystick2 & (this.ram[0xDC00] | 0x00);

            case 0x01: // Port B - Keyboard column read / Joystick 1
                // Joystick 1 is ORed with keyboard matrix
                let result = this.joystick1;

                if (this.stopKeyPressed) {
                    const rowSelect = this.ram[0xDC00];
                    if ((rowSelect & 0x80) === 0) {
                        result &= 0x7F; // STOP key pressed (active low)
                    }
                }
                return result;

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
                this.cia1.icrData = 0; // Clear on read
                // Update IRQ line - may clear IRQ if no other sources active
                this.updateIRQLine();
                return icrValue;

            case 0x0E: // Control Register A
                return this.cia1.cra;

            case 0x0F: // Control Register B
                return this.cia1.crb;

            default:
                return this.ram[addr];
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
                this.ram[addr] = val;
        }
    }

    //
    // Read from CIA2 registers
    // CIA2 handles VIC bank selection and NMI timer
    //
    readCIA2(addr) {
        const reg = addr & 0x0F;

        switch (reg) {
            case 0x00: // Port A - VIC bank selection
                return this.ram[addr];  // Return output latch (bits 0-1 are outputs)

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
                this.cia2.icrData = 0; // Clear on read
                // Update NMI line state - clearing interrupt may release NMI
                this.updateNMI();
                return icrValue;

            case 0x0E: // Control Register A
                return this.cia2.cra;

            case 0x0F: // Control Register B
                return this.cia2.crb;

            default:
                return this.ram[addr];
        }
    }

    //
    // Write to CIA2 registers
    //
    writeCIA2(addr, val) {
        const reg = addr & 0x0F;

        switch (reg) {
            case 0x00: // Port A - VIC bank selection
                this.ram[addr] = val;
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
                this.ram[addr] = val;
        }
    }

    //
    // Update NMI line state and trigger NMI on falling edge
    // NMI is edge-triggered (high-to-low transition)
    //
    updateNMI() {
        // NMI is active when interrupt occurred AND NMI is enabled for that source
        const nmiActive = (this.cia2.icrData & 0x01) && this.cia2.timerANmiEnabled;

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
        // Check all IRQ sources:
        // 1. VIC-II: irqStatus bit 7 set means active IRQ
        // 2. CIA1: icrData bit 7 set means active IRQ
        const vicIRQ = (this.vic.irqStatus & 0x80) !== 0;
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
    // @returns {boolean} True if timer underflowed
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

        if (cia[counterKey] <= 0) {
            // Reload from latch
            cia[counterKey] += cia[latchKey];

            // Set timer interrupt flag
            cia.icrData |= irqFlag;

            // One-shot mode: stop timer after underflow (CR bit 3)
            if (cia[crKey] & 0x08) {
                cia[runningKey] = false;
                cia[crKey] &= ~0x01; // Clear start bit
            }

            // Trigger interrupt if enabled
            if (cia[irqEnabledKey]) {
                cia.icrData |= 0x80; // Set "interrupt occurred" flag
                triggerInterrupt();
            }

            return true;
        }
        return false;
    }

    //
    // Tick Timer B when it's counting Timer A underflows
    // @param {Object} cia - CIA state object
    // @param {Function} triggerInterrupt - Function to call when interrupt fires
    //
    tickCIATimerBFromA(cia, triggerInterrupt) {
        const irqEnabledKey = cia === this.cia1 ? 'timerBIrqEnabled' : 'timerBNmiEnabled';

        cia.timerBCounter--;
        if (cia.timerBCounter < 0) {
            cia.timerBCounter = cia.timerBLatch;
            cia.icrData |= 0x02; // Timer B underflow flag

            if (cia.crb & 0x08) {
                cia.timerBRunning = false;
                cia.crb &= ~0x01;
            }

            if (cia[irqEnabledKey]) {
                cia.icrData |= 0x80;
                triggerInterrupt();
            }
        }
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
    // Press the RUN/STOP key
    //
    pressStop() {
        this.stopKeyPressed = true;
        setTimeout(() => {
            this.stopKeyPressed = false;
        }, 150);
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
        const cyclesPerFullFrame = CYCLES_PER_RASTER_LINE * RASTER_LINES_PER_FRAME;
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
        }

        // Audio interleaving state
        let audioBufferIndex = 0;
        let lastSidClockCycles = 0;

        // Cache state for faster access
        const cia1 = this.cia1;
        const cia2 = this.cia2;
        const vic = this.vic;
        const cpu = this.cpu;
        const ram = this.ram;
        const cyclesPerRasterLine = CYCLES_PER_RASTER_LINE;
        const cyclesPerFullFrame = CYCLES_PER_RASTER_LINE * RASTER_LINES_PER_FRAME;

        // Reset raster cycle counter at frame start
        vic.rasterCycle = 0;
        vic.lastRasterLine = -1;
        vic.badLineStunned = false; // Reset stun flag

        // Execute CPU for one frame's worth of cycles, ticking CIA timer
        let cyclesExecuted = 0;
        while (cyclesExecuted < this.cyclesPerFrame) {
            if (cpu.halted) break;

            // DEBUG: Trace first few instructions of playback
            if (this.traceEnabled && this.traceCount < 50) {
                const pc = cpu.PC;
                const op = this.read(pc);
                console.log(`TRACE: PC=$${pc.toString(16)} Op=$${op.toString(16)} A=$${cpu.A.toString(16)} X=$${cpu.X.toString(16)} Y=$${cpu.Y.toString(16)}`);
                this.traceCount++;
            }

            const stepCycles = cpu.step();
            cyclesExecuted += stepCycles;

            // Tick CIA1 Timer A
            if (cia1.timerARunning) {
                const underflowed = this.tickCIATimer(
                    cia1, 'A', stepCycles,
                    () => this.updateIRQLine()
                );
                // Check if Timer B is counting Timer A underflows (CRB bits 5-6 = 10 or 11)
                if (underflowed && cia1.timerBRunning && ((cia1.crb & 0x60) >= 0x40)) {
                    this.tickCIATimerBFromA(cia1, () => this.updateIRQLine());
                }
            }

            // Tick CIA1 Timer B (when counting system clock - CRB bits 5-6 = 00)
            if (cia1.timerBRunning && ((cia1.crb & 0x60) === 0x00)) {
                this.tickCIATimer(cia1, 'B', stepCycles, () => this.updateIRQLine());
            }

            // Tick CIA2 Timer A (NMI timer for sample playback)
            if (cia2.timerARunning) {
                const underflowed = this.tickCIATimer(
                    cia2, 'A', stepCycles,
                    () => this.updateNMI()
                );
                // Check if Timer B is counting Timer A underflows (CRB bits 5-6 = 10 or 11)
                if (underflowed && cia2.timerBRunning && ((cia2.crb & 0x60) >= 0x40)) {
                    this.tickCIATimerBFromA(cia2, () => this.updateNMI());
                }
            }

            // Tick CIA2 Timer B (when counting system clock - CRB bits 5-6 = 00)
            if (cia2.timerBRunning && ((cia2.crb & 0x60) === 0x00)) {
                this.tickCIATimer(cia2, 'B', stepCycles, () => this.updateNMI());
            }

            // Check for VIC-II raster IRQ
            // Calculate current raster line based on global cycle counter
            vic.rasterCycle += stepCycles;

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
                    vic.renderer.renderScanline(vic.frameBuffer, ram, vic.lastRasterLine);
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

            // Check for Bad Line (BA Low)
            // Stun CPU for ~40 cycles if this is a Bad Line and we haven't stunned yet
            if (!vic.badLineStunned && vic.renderer.checkBadLine(ram, currentRasterLine)) {
                const stunCycles = 40;
                cpu.cycles += stunCycles;
                cyclesExecuted += stunCycles;
                vic.badLineStunned = true;
            }
        }

        // Render the final scanline of the frame (since we render the previous line on transition)
        if (vic.lastRasterLine >= 0) {
            vic.renderer.renderScanline(vic.frameBuffer, ram, vic.lastRasterLine);
        }

        // Generate remaining audio samples
        if (audioBuffer && this.audioEnabled) {
            const currentCycles = cyclesExecuted;
            const cyclesSinceLast = currentCycles - lastSidClockCycles;
            if (cyclesSinceLast > 0) {
                const targetBuf = audioBuffer.subarray(audioBufferIndex);
                this.sid.clock(cyclesSinceLast, targetBuf, this.frameCycleStart + lastSidClockCycles);
            }
        }

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
    // Load a CRT cartridge file
    //
    // CRT format:
    //   - 64-byte header starting with "C64 CARTRIDGE"
    //   - CHIP packets containing ROM data
    //
    // @param {Uint8Array} data - The CRT file data
    // @returns {object} Cartridge info (name, type, chips loaded)
    //
    loadCrt(data) {
        // Validate CRT signature
        const signature = String.fromCharCode(...data.slice(0, 16)).replace(/\0/g, '');
        if (!signature.startsWith('C64 CARTRIDGE')) {
            throw new Error('Invalid CRT file: missing C64 CARTRIDGE signature');
        }

        // Parse header (64 bytes)
        const headerLength = (data[0x10] << 24) | (data[0x11] << 16) | (data[0x12] << 8) | data[0x13];
        const version = (data[0x14] << 8) | data[0x15];
        const cartType = (data[0x16] << 8) | data[0x17];
        const exrom = data[0x18];  // /EXROM line (active low: 0=active, 1=inactive)
        const game = data[0x19];   // /GAME line (active low: 0=active, 1=inactive)

        // Get cartridge name (32 bytes at offset 0x20)
        let name = '';
        for (let i = 0x20; i < 0x40 && data[i] !== 0; i++) {
            name += String.fromCharCode(data[i]);
        }

        console.log(`CRT: ${name || 'Unknown'}, Type: ${cartType}, Version: ${version >> 8}.${version & 0xFF}`);
        console.log(`CRT: EXROM=${exrom}, GAME=${game}`);

        // Set cartridge lines
        this.cartExrom = exrom !== 0;
        this.cartGame = game !== 0;

        // Parse CHIP packets
        let offset = headerLength;
        const chips = [];

        while (offset < data.length) {
            // CHIP header (16 bytes)
            const chipSig = String.fromCharCode(...data.slice(offset, offset + 4));
            if (chipSig !== 'CHIP') {
                break;
            }

            const chipLength = (data[offset + 4] << 24) | (data[offset + 5] << 16) |
                (data[offset + 6] << 8) | data[offset + 7];
            const chipType = (data[offset + 8] << 8) | data[offset + 9];
            const bank = (data[offset + 10] << 8) | data[offset + 11];
            const loadAddr = (data[offset + 12] << 8) | data[offset + 13];
            const romSize = (data[offset + 14] << 8) | data[offset + 15];

            // Extract ROM data
            const romData = data.slice(offset + 16, offset + 16 + romSize);

            console.log(`CRT CHIP: Type=${chipType}, Bank=${bank}, Addr=$${loadAddr.toString(16).padStart(4, '0')}, Size=${romSize}`);

            // Store in appropriate ROM slot based on load address
            if (loadAddr === 0x8000) {
                this.cartRomL = new Uint8Array(romData);
            } else if (loadAddr === 0xA000 || loadAddr === 0xE000) {
                this.cartRomH = new Uint8Array(romData);
            }

            chips.push({ type: chipType, bank, loadAddr, size: romSize });
            offset += chipLength;
        }

        return { name, type: cartType, exrom, game, chips };
    }

    //
    // Remove the currently loaded cartridge
    //
    removeCartridge() {
        this.cartRomL = null;
        this.cartRomH = null;
        this.cartGame = true;
        this.cartExrom = true;
        console.log('Cartridge removed');
    }
}

