//
// @fileoverview CRT Cartridge Support for Turbo8bit
// @module emulator/cartridge
//
// This module provides C64 cartridge (.CRT) file format support:
// - CRT header parsing (64-byte header with signature, type, EXROM/GAME lines)
// - CHIP packet parsing (ROM banks with type, bank number, load address)
// - Bank switching for various cartridge types
// - Memory mapping based on EXROM/GAME line states
//
// Supported cartridge types:
// - Type 0: Normal cartridge (8K/16K)
// - Type 1: Action Replay
// - Type 3: Final Cartridge III
// - Type 5: Ocean type 1
// - Type 15: C64 Game System (System 3)
// - Type 17: Dinamic
// - Type 19: Magic Desk, Domark, HES Australia
// - And more...
//
// @see https://ist.uwaterloo.ca/~schepers/formats/CRT.TXT
// @see https://www.turbo8bit.com/
//

// ============================================================================
// CRT HEADER CONSTANTS
// ============================================================================

// CRT file signature
export const CRT_SIGNATURE = 'C64 CARTRIDGE   ';

// Header offsets
export const CRT_HEADER = {
    SIGNATURE: 0x0000,      // 16 bytes: "C64 CARTRIDGE   "
    HEADER_LENGTH: 0x0010,  // 4 bytes: Header length (usually 0x40)
    VERSION: 0x0014,        // 2 bytes: Version (high/low, usually 01.00)
    HARDWARE_TYPE: 0x0016,  // 2 bytes: Cartridge hardware type
    EXROM: 0x0018,          // 1 byte: EXROM line status
    GAME: 0x0019,           // 1 byte: GAME line status
    RESERVED: 0x001A,       // 6 bytes: Reserved
    NAME: 0x0020,           // 32 bytes: Cartridge name (null-padded)
    CHIPS_START: 0x0040     // CHIP packets start here
};

// CHIP packet header offsets (relative to packet start)
export const CHIP_HEADER = {
    SIGNATURE: 0x0000,      // 4 bytes: "CHIP"
    PACKET_LENGTH: 0x0004,  // 4 bytes: Total packet length (header + ROM data)
    CHIP_TYPE: 0x0008,      // 2 bytes: Chip type (0=ROM, 1=RAM, 2=Flash)
    BANK_NUMBER: 0x000A,    // 2 bytes: Bank number
    LOAD_ADDRESS: 0x000C,   // 2 bytes: Starting load address
    ROM_SIZE: 0x000E,       // 2 bytes: ROM image size
    ROM_DATA: 0x0010        // ROM data starts here
};

// Chip types
export const CHIP_TYPE = {
    ROM: 0,
    RAM: 1,
    FLASH: 2
};

// ============================================================================
// CARTRIDGE HARDWARE TYPES
// ============================================================================

export const CARTRIDGE_TYPE = {
    NORMAL: 0,
    ACTION_REPLAY: 1,
    KCS_POWER: 2,
    FINAL_CARTRIDGE_III: 3,
    SIMONS_BASIC: 4,
    OCEAN_TYPE_1: 5,
    EXPERT: 6,
    FUN_PLAY: 7,
    SUPER_GAMES: 8,
    ATOMIC_POWER: 9,
    EPYX_FASTLOAD: 10,
    WESTERMANN: 11,
    REX_UTILITY: 12,
    FINAL_CARTRIDGE_I: 13,
    MAGIC_FORMEL: 14,
    C64_GAME_SYSTEM: 15,
    WARPSPEED: 16,
    DINAMIC: 17,
    ZAXXON: 18,
    MAGIC_DESK: 19,
    SUPER_SNAPSHOT_5: 20,
    COMAL_80: 21,
    STRUCTURED_BASIC: 22,
    ROSS: 23,
    DELA_EP64: 24,
    DELA_EP7X8: 25,
    DELA_EP256: 26,
    REX_EP256: 27,
    EASYFLASH: 32
};

// Cartridge type names for display
export const CARTRIDGE_TYPE_NAMES = {
    [CARTRIDGE_TYPE.NORMAL]: 'Normal cartridge',
    [CARTRIDGE_TYPE.ACTION_REPLAY]: 'Action Replay',
    [CARTRIDGE_TYPE.KCS_POWER]: 'KCS Power Cartridge',
    [CARTRIDGE_TYPE.FINAL_CARTRIDGE_III]: 'Final Cartridge III',
    [CARTRIDGE_TYPE.SIMONS_BASIC]: 'Simons Basic',
    [CARTRIDGE_TYPE.OCEAN_TYPE_1]: 'Ocean type 1',
    [CARTRIDGE_TYPE.EXPERT]: 'Expert Cartridge',
    [CARTRIDGE_TYPE.FUN_PLAY]: 'Fun Play / Power Play',
    [CARTRIDGE_TYPE.SUPER_GAMES]: 'Super Games',
    [CARTRIDGE_TYPE.ATOMIC_POWER]: 'Atomic Power',
    [CARTRIDGE_TYPE.EPYX_FASTLOAD]: 'Epyx Fastload',
    [CARTRIDGE_TYPE.WESTERMANN]: 'Westermann Learning',
    [CARTRIDGE_TYPE.REX_UTILITY]: 'Rex Utility',
    [CARTRIDGE_TYPE.FINAL_CARTRIDGE_I]: 'Final Cartridge I',
    [CARTRIDGE_TYPE.MAGIC_FORMEL]: 'Magic Formel',
    [CARTRIDGE_TYPE.C64_GAME_SYSTEM]: 'C64 Game System',
    [CARTRIDGE_TYPE.EASYFLASH]: 'EasyFlash',
    [CARTRIDGE_TYPE.WARPSPEED]: 'WarpSpeed',
    [CARTRIDGE_TYPE.DINAMIC]: 'Dinamic',
    [CARTRIDGE_TYPE.ZAXXON]: 'Zaxxon / Super Zaxxon',
    [CARTRIDGE_TYPE.MAGIC_DESK]: 'Magic Desk / Domark / HES',
    [CARTRIDGE_TYPE.SUPER_SNAPSHOT_5]: 'Super Snapshot 5',
    [CARTRIDGE_TYPE.COMAL_80]: 'Comal-80',
    [CARTRIDGE_TYPE.STRUCTURED_BASIC]: 'Structured Basic',
    [CARTRIDGE_TYPE.ROSS]: 'Ross',
    [CARTRIDGE_TYPE.DELA_EP64]: 'Dela EP64',
    [CARTRIDGE_TYPE.DELA_EP7X8]: 'Dela EP7x8',
    [CARTRIDGE_TYPE.DELA_EP256]: 'Dela EP256',
    [CARTRIDGE_TYPE.REX_EP256]: 'Rex EP256'
};

// ============================================================================
// MEMORY CONFIGURATION TABLE
// ============================================================================
//
// Based on EXROM/GAME line states, the C64 memory map changes.
// This table shows what appears at each memory range.
//
// Legend: L=ROML, H=ROMH, G=GAME, E=EXROM
//
// LHGE   Memory Configuration
// ----   --------------------
// 1111   Default (no cartridge)
// 101X   8K cartridge (ROML at $8000-$9FFF)
// 1000   16K cartridge (ROML at $8000, ROMH at $A000)
// XX01   Ultimax mode (ROML at $8000, ROMH at $E000)
//

export const MEMORY_CONFIG = {
    // EXROM=0, GAME=1: 8K cartridge mode
    // ROML mapped at $8000-$9FFF
    MODE_8K: { exrom: 0, game: 1, romlAddr: 0x8000, romhAddr: null },

    // EXROM=0, GAME=0: 16K cartridge mode
    // ROML at $8000-$9FFF, ROMH at $A000-$BFFF
    MODE_16K: { exrom: 0, game: 0, romlAddr: 0x8000, romhAddr: 0xA000 },

    // EXROM=1, GAME=0: Ultimax mode
    // ROML at $8000-$9FFF, ROMH at $E000-$FFFF
    MODE_ULTIMAX: { exrom: 1, game: 0, romlAddr: 0x8000, romhAddr: 0xE000 },

    // EXROM=1, GAME=1: No cartridge (default)
    MODE_OFF: { exrom: 1, game: 1, romlAddr: null, romhAddr: null }
};

// ============================================================================
// CHIP BANK CLASS
// ============================================================================

//
// Represents a single ROM/RAM chip bank from a CRT file
//
export class ChipBank {
    constructor() {
        this.type = CHIP_TYPE.ROM;    // Chip type (ROM/RAM/Flash)
        this.bankNumber = 0;           // Bank number
        this.loadAddress = 0x8000;     // Starting load address
        this.size = 0;                 // ROM size in bytes
        this.data = null;              // Uint8Array of ROM data
    }
}

// ============================================================================
// CARTRIDGE CLASS
// ============================================================================

//
// C64 Cartridge - Handles CRT file loading and bank switching
//
// Manages:
// - CRT file parsing
// - Multiple ROM banks
// - Bank switching logic per cartridge type
// - EXROM/GAME line control
// - Memory mapping
//
export class Cartridge {
    constructor() {
        // Header info
        this.name = '';
        this.version = { major: 1, minor: 0 };
        this.hardwareType = CARTRIDGE_TYPE.NORMAL;

        // Control lines
        this.exrom = 1;  // EXROM line (active low: 0 = active)
        this.game = 1;   // GAME line (active low: 0 = active)

        // Original header values (for reset)
        this.headerExrom = 1;
        this.headerGame = 1;

        // ROM banks
        this.banks = [];          // Array of ChipBank objects
        this.currentBank = 0;     // Currently selected bank
        this.romlBank = null;     // Current ROML bank (if any)
        this.romhBank = null;     // Current ROMH bank (if any)

        // Cartridge state
        this.enabled = false;
        this.ultimaxMode = false;

        // EasyFlash-specific state
        this.easyFlashRAM = null;     // 256 bytes RAM at I/O-2 ($DF00-$DFFF)
        this.easyFlashJumper = false; // EasyFlash jumper (active = boot mode)
        this.easyFlashControl = 0;    // Control register at $DE02
    }

    //
    // Load a CRT file from an ArrayBuffer
    // @param {ArrayBuffer} data - Raw CRT file data
    // @returns {boolean} True if loaded successfully
    //
    load(data) {
        const view = new DataView(data);
        const bytes = new Uint8Array(data);

        // Verify signature
        let signature = '';
        for (let i = 0; i < 16; i++) {
            signature += String.fromCharCode(bytes[i]);
        }
        if (signature !== CRT_SIGNATURE) {
            console.error('Invalid CRT signature:', signature);
            return false;
        }

        // Parse header
        const headerLength = view.getUint32(CRT_HEADER.HEADER_LENGTH, false);
        this.version.major = bytes[CRT_HEADER.VERSION];
        this.version.minor = bytes[CRT_HEADER.VERSION + 1];
        this.hardwareType = view.getUint16(CRT_HEADER.HARDWARE_TYPE, false);
        this.exrom = bytes[CRT_HEADER.EXROM];
        this.game = bytes[CRT_HEADER.GAME];

        // Store original header values for reset
        this.headerExrom = this.exrom;
        this.headerGame = this.game;

        // Parse name (32 bytes, null-terminated)
        this.name = '';
        for (let i = 0; i < 32; i++) {
            const c = bytes[CRT_HEADER.NAME + i];
            if (c === 0) break;
            this.name += String.fromCharCode(c);
        }

        console.log(`Loading CRT: "${this.name}" (${CARTRIDGE_TYPE_NAMES[this.hardwareType] || 'Unknown'})`);
        console.log(`  Version: ${this.version.major}.${this.version.minor}`);
        console.log(`  EXROM: ${this.exrom}, GAME: ${this.game}`);

        // Parse CHIP packets
        this.banks = [];
        let offset = headerLength;

        while (offset < data.byteLength) {
            // Check for CHIP signature
            const chipSig = String.fromCharCode(
                bytes[offset], bytes[offset + 1],
                bytes[offset + 2], bytes[offset + 3]
            );
            if (chipSig !== 'CHIP') {
                console.warn(`Expected CHIP signature at offset ${offset}, got "${chipSig}"`);
                break;
            }

            const packetLength = view.getUint32(offset + CHIP_HEADER.PACKET_LENGTH, false);
            const chipType = view.getUint16(offset + CHIP_HEADER.CHIP_TYPE, false);
            const bankNumber = view.getUint16(offset + CHIP_HEADER.BANK_NUMBER, false);
            const loadAddress = view.getUint16(offset + CHIP_HEADER.LOAD_ADDRESS, false);
            const romSize = view.getUint16(offset + CHIP_HEADER.ROM_SIZE, false);

            const bank = new ChipBank();
            bank.type = chipType;
            bank.bankNumber = bankNumber;
            bank.loadAddress = loadAddress;
            bank.size = romSize;
            bank.data = bytes.slice(offset + CHIP_HEADER.ROM_DATA, offset + CHIP_HEADER.ROM_DATA + romSize);

            this.banks.push(bank);

            console.log(`  CHIP: Bank ${bankNumber}, $${loadAddress.toString(16).toUpperCase()}, ${romSize} bytes`);

            offset += packetLength;
        }

        if (this.banks.length === 0) {
            console.error('No CHIP packets found in CRT file');
            return false;
        }

        // Initialize cartridge state
        this.enabled = true;
        this.currentBank = 0;
        this.ultimaxMode = (this.exrom === 1 && this.game === 0);

        // Initialize EasyFlash-specific state
        if (this.hardwareType === CARTRIDGE_TYPE.EASYFLASH) {
            this.easyFlashRAM = new Uint8Array(256);  // 256 bytes RAM at I/O-2 ($DF00-$DFFF)
            this.easyFlashJumper = true;  // Boot jumper enabled (directly start cart)
            this.easyFlashControl = 0;    // Control register at $DE02
            // Respect the CRT header's mode - Ultimax carts use EXROM=1, GAME=0
            // The jumper controls whether cart boots immediately, not the mode
            // Keep ultimaxMode from header settings
        }

        // Set initial bank mapping
        this.updateBankMapping();

        return true;
    }

    //
    // Update ROML/ROMH bank mapping based on current bank selection
    // @private
    //
    updateBankMapping() {
        this.romlBank = null;
        this.romhBank = null;

        for (const bank of this.banks) {
            if (bank.bankNumber === this.currentBank) {
                if (bank.loadAddress === 0x8000) {
                    this.romlBank = bank;
                    // For 16KB banks (size 16384), the same bank also provides ROMH
                    // at offset $2000 into the bank data
                    if (bank.size === 16384) {
                        this.romhBank = bank;
                    }
                } else if (bank.loadAddress === 0xA000) {
                    this.romhBank = bank;
                } else if (bank.loadAddress === 0xE000 || bank.loadAddress === 0xF000) {
                    // Ultimax mode - ROMH at $E000 or $F000
                    this.romhBank = bank;
                }
            }
        }
    }

    //
    // Get the current memory configuration based on EXROM/GAME lines
    // @returns {Object} Memory configuration
    //
    getMemoryConfig() {
        if (this.exrom === 0 && this.game === 1) {
            return MEMORY_CONFIG.MODE_8K;
        } else if (this.exrom === 0 && this.game === 0) {
            return MEMORY_CONFIG.MODE_16K;
        } else if (this.exrom === 1 && this.game === 0) {
            return MEMORY_CONFIG.MODE_ULTIMAX;
        }
        return MEMORY_CONFIG.MODE_OFF;
    }

    //
    // Read a byte from cartridge ROM
    // @param {number} addr - Address to read (0x0000-0xFFFF)
    // @returns {number|null} Byte value or null if not mapped
    //
    read(addr) {
        if (!this.enabled) return null;

        const config = this.getMemoryConfig();

        // Check ROML range ($8000-$9FFF)
        if (this.romlBank && addr >= 0x8000 && addr <= 0x9FFF) {
            const offset = addr - 0x8000;
            if (offset < this.romlBank.size) {
                return this.romlBank.data[offset];
            }
        }

        // Check ROMH range ($A000-$BFFF or $E000-$FFFF depending on mode)
        if (this.romhBank) {
            if (config.romhAddr === 0xA000 && addr >= 0xA000 && addr <= 0xBFFF) {
                // For 16KB banks loaded at $8000, ROMH data is at offset $2000
                if (this.romhBank.loadAddress === 0x8000 && this.romhBank.size === 16384) {
                    const offset = 0x2000 + (addr - 0xA000);
                    if (offset < this.romhBank.size) {
                        return this.romhBank.data[offset];
                    }
                } else {
                    // Normal ROMH bank loaded at $A000
                    const offset = addr - 0xA000;
                    if (offset < this.romhBank.size) {
                        return this.romhBank.data[offset];
                    }
                }
            } else if (config.romhAddr === 0xE000 && addr >= 0xE000 && addr <= 0xFFFF) {
                // Ultimax mode: ROMH appears at $E000-$FFFF
                // EasyFlash stores banks at $A000 in CRT but they map to $E000 in Ultimax
                // Always use $E000 as the base for offset calculation in Ultimax mode
                const offset = addr - 0xE000;
                if (offset < this.romhBank.size) {
                    return this.romhBank.data[offset];
                }
            }
        }

        return null;
    }

    //
    // Write to cartridge I/O space (bank switching)
    // @param {number} addr - Address written to
    // @param {number} value - Value written
    //
    write(addr, value) {
        if (!this.enabled) return;

        // Handle bank switching based on cartridge type
        switch (this.hardwareType) {
            case CARTRIDGE_TYPE.NORMAL:
                // Normal cartridges don't have bank switching
                break;

            case CARTRIDGE_TYPE.OCEAN_TYPE_1:
                // Ocean: Write to $DE00, lower 6 bits = bank number
                if (addr === 0xDE00) {
                    this.currentBank = value & 0x3F;
                    this.updateBankMapping();
                }
                break;

            case CARTRIDGE_TYPE.FUN_PLAY:
                // Fun Play: Write to $DE00 with special bit mapping
                // Bits: xx210xx3 -> bank 0-15
                if (addr === 0xDE00) {
                    if (value === 0x86) {
                        // Disable cartridge
                        this.enabled = false;
                    } else {
                        const bank = ((value >> 3) & 0x07) | ((value & 0x01) << 3);
                        this.currentBank = bank;
                        this.updateBankMapping();
                    }
                }
                break;

            case CARTRIDGE_TYPE.SUPER_GAMES:
                // Super Games: Write to $DF00
                if (addr === 0xDF00) {
                    this.currentBank = value & 0x03;
                    // Bit 3 + Bit 2 both set = cartridge off
                    if ((value & 0x0C) === 0x0C) {
                        this.enabled = false;
                    }
                    this.updateBankMapping();
                }
                break;

            case CARTRIDGE_TYPE.C64_GAME_SYSTEM:
                // C64GS: Read from $DE00+X selects bank X
                // Write handling not typically used, but we handle the address
                if (addr >= 0xDE00 && addr <= 0xDEFF) {
                    this.currentBank = addr & 0x3F;
                    this.updateBankMapping();
                }
                break;

            case CARTRIDGE_TYPE.DINAMIC:
                // Dinamic: Read from $DE00+X selects bank X (similar to C64GS)
                if (addr >= 0xDE00 && addr <= 0xDEFF) {
                    this.currentBank = addr & 0x0F;
                    this.updateBankMapping();
                }
                break;

            case CARTRIDGE_TYPE.MAGIC_DESK:
                // Magic Desk: Write to $DE00, bit 7 set = disable ROM
                if (addr === 0xDE00) {
                    if (value & 0x80) {
                        this.enabled = false;
                    } else {
                        this.currentBank = value & 0x3F;
                        this.updateBankMapping();
                    }
                }
                break;

            case CARTRIDGE_TYPE.FINAL_CARTRIDGE_III:
                // Final Cartridge III: Write bank number + $40 to $DFFF
                if (addr === 0xDFFF) {
                    this.currentBank = value & 0x03;
                    this.updateBankMapping();
                }
                break;

            case CARTRIDGE_TYPE.ACTION_REPLAY:
            case CARTRIDGE_TYPE.ATOMIC_POWER:
                // Action Replay / Atomic Power: Write to $DE00
                if (addr === 0xDE00) {
                    this.currentBank = value & 0x03;
                    // Additional control bits for freezer functionality
                    this.updateBankMapping();
                }
                break;

            case CARTRIDGE_TYPE.SIMONS_BASIC:
                // Simons Basic: $DE00 = ROM on, $DE00 with 0 = ROM off
                if (addr === 0xDE00) {
                    if (value === 0x01) {
                        this.enabled = true;
                        this.game = 0;  // Enable 16K mode
                    } else {
                        this.game = 1;  // Back to 8K mode
                    }
                    this.updateBankMapping();
                }
                break;

            case CARTRIDGE_TYPE.COMAL_80:
                // Comal-80: $DE00 with values $80-$83 select banks 0-3
                if (addr === 0xDE00) {
                    this.currentBank = value & 0x03;
                    this.updateBankMapping();
                }
                break;

            case CARTRIDGE_TYPE.WARPSPEED:
                // WarpSpeed: Write to $DF00 disables ROM, $DE00 enables
                if (addr >= 0xDF00 && addr <= 0xDFFF) {
                    this.enabled = false;
                } else if (addr >= 0xDE00 && addr <= 0xDEFF) {
                    this.enabled = true;
                }
                break;

            case CARTRIDGE_TYPE.EPYX_FASTLOAD:
                // Epyx Fastload: Trigger on read from $DE00 area
                // ROM disable handled via capacitor timing (not fully emulated)
                break;

            case CARTRIDGE_TYPE.ZAXXON:
                // Zaxxon: Read from $8000-$8FFF = bank 0, $9000-$9FFF = bank 1
                // This is typically handled in read(), not write()
                break;

            case CARTRIDGE_TYPE.ROSS:
                // Ross: Read $DE00 = bank 1, Read $DF00 = disable
                if (addr >= 0xDF00 && addr <= 0xDFFF) {
                    this.enabled = false;
                } else if (addr >= 0xDE00 && addr <= 0xDEFF) {
                    this.currentBank = 1;
                    this.updateBankMapping();
                }
                break;

            case CARTRIDGE_TYPE.EASYFLASH:
                // EasyFlash: $DE00 = bank select, $DE02 = control register
                // $DF00-$DFFF = 256 bytes RAM
                if (addr === 0xDE00) {
                    // Bank register: bits 0-5 select bank (0-63)
                    this.currentBank = value & 0x3F;
                    this.updateBankMapping();
                } else if (addr === 0xDE02) {
                    // Control register:
                    // Bit 0: GAME line (active low - 0 = active/asserted, 1 = inactive/high)
                    // Bit 1: EXROM line (active low - 0 = active/asserted, 1 = inactive/high)
                    // Bit 2: Mode (0 = boot mode with GAME/EXROM active, 1 = software controlled)
                    // Bit 7: LED (optional, ignored)
                    this.easyFlashControl = value;

                    // In EasyFlash boot mode (jumper + mode=0), the cartridge starts
                    // When mode bit is 1, use GAME/EXROM from control register
                    if (value & 0x04) {  // Mode bit (note: some docs say bit 2, others bit 7)
                        // Mode bit set: use software control of /GAME and /EXROM
                        this.game = (value & 0x01) ? 0 : 1;     // Bit 0: /GAME (active low, so 0=asserted=0, 1=released=1)
                        this.exrom = (value & 0x02) ? 0 : 1;    // Bit 1: /EXROM
                        this.ultimaxMode = (this.exrom === 0 && this.game === 1);
                    } else {
                        // Boot mode: cartridge active (16K mode)
                        this.game = 0;
                        this.exrom = 0;
                        this.ultimaxMode = false;
                    }
                    this.updateBankMapping();
                } else if (addr >= 0xDF00 && addr <= 0xDFFF) {
                    // EasyFlash RAM write
                    if (this.easyFlashRAM) {
                        this.easyFlashRAM[addr & 0xFF] = value;
                    }
                }
                break;

            default:
                // Unknown cartridge type - no bank switching
                break;
        }
    }

    //
    // Handle reads from I/O space (some cartridges use read for bank switching)
    // @param {number} addr - Address being read
    // @returns {number|null} Value to return, or null for normal read
    //
    readIO(addr) {
        if (!this.enabled) return null;

        switch (this.hardwareType) {
            case CARTRIDGE_TYPE.C64_GAME_SYSTEM:
            case CARTRIDGE_TYPE.DINAMIC:
                // Bank switching via read access
                if (addr >= 0xDE00 && addr <= 0xDEFF) {
                    this.currentBank = addr & 0x3F;
                    this.updateBankMapping();
                }
                return 0;  // Return dummy value

            case CARTRIDGE_TYPE.ZAXXON:
                // Zaxxon bank switching via address access
                // This should be handled in the main read path
                break;

            case CARTRIDGE_TYPE.WARPSPEED:
                // WarpSpeed mirrors ROM at $DE00-$DFFF
                if (addr >= 0xDE00 && addr <= 0xDFFF) {
                    const offset = 0x1E00 + (addr & 0x1FF);
                    if (this.romlBank && offset < this.romlBank.size) {
                        return this.romlBank.data[offset];
                    }
                }
                break;

            case CARTRIDGE_TYPE.ROSS:
                if (addr >= 0xDE00 && addr <= 0xDEFF) {
                    this.currentBank = 1;
                    this.updateBankMapping();
                } else if (addr >= 0xDF00 && addr <= 0xDFFF) {
                    this.enabled = false;
                }
                return 0;

            case CARTRIDGE_TYPE.EASYFLASH:
                // EasyFlash RAM at $DF00-$DFFF
                if (addr >= 0xDF00 && addr <= 0xDFFF) {
                    if (this.easyFlashRAM) {
                        return this.easyFlashRAM[addr & 0xFF];
                    }
                }
                // Reads from $DE00-$DEFF return open bus (not handled here)
                return null;

            default:
                break;
        }

        return null;
    }

    //
    // Reset cartridge to initial state
    //
    reset() {
        this.currentBank = 0;
        this.enabled = this.banks.length > 0;

        // Restore original EXROM/GAME from header for all cartridge types
        this.exrom = this.headerExrom;
        this.game = this.headerGame;
        this.ultimaxMode = (this.exrom === 1 && this.game === 0);

        // Reset EasyFlash-specific state
        if (this.hardwareType === CARTRIDGE_TYPE.EASYFLASH) {
            this.easyFlashControl = 0;
            if (this.easyFlashRAM) {
                this.easyFlashRAM.fill(0);
            }
        }

        this.updateBankMapping();
    }

    //
    // Check if address is mapped to cartridge ROM
    // @param {number} addr - Address to check
    // @returns {boolean} True if mapped to cartridge
    //
    isMapped(addr) {
        if (!this.enabled) return false;

        const config = this.getMemoryConfig();

        // Check ROML range
        if (config.romlAddr !== null && addr >= 0x8000 && addr <= 0x9FFF) {
            return this.romlBank !== null;
        }

        // Check ROMH range
        if (config.romhAddr === 0xA000 && addr >= 0xA000 && addr <= 0xBFFF) {
            return this.romhBank !== null;
        }
        if (config.romhAddr === 0xE000 && addr >= 0xE000 && addr <= 0xFFFF) {
            return this.romhBank !== null;
        }

        return false;
    }

    //
    // Get cartridge info for display
    // @returns {Object} Cartridge information
    //
    getInfo() {
        return {
            name: this.name,
            type: this.hardwareType,
            typeName: CARTRIDGE_TYPE_NAMES[this.hardwareType] || 'Unknown',
            version: `${this.version.major}.${this.version.minor}`,
            exrom: this.exrom,
            game: this.game,
            bankCount: this.banks.length,
            currentBank: this.currentBank,
            enabled: this.enabled,
            totalSize: this.banks.reduce((sum, b) => sum + b.size, 0)
        };
    }

    //
    // Eject the cartridge
    //
    eject() {
        this.banks = [];
        this.enabled = false;
        this.name = '';
        this.currentBank = 0;
        this.romlBank = null;
        this.romhBank = null;
        this.exrom = 1;
        this.game = 1;
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

//
// Load a CRT file from a URL
// @param {string} url - URL to the CRT file
// @returns {Promise<Cartridge>} Loaded cartridge
//
export async function loadCRTFromURL(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to load CRT: ${response.statusText}`);
    }

    const data = await response.arrayBuffer();
    const cartridge = new Cartridge();

    if (!cartridge.load(data)) {
        throw new Error('Failed to parse CRT file');
    }

    return cartridge;
}

//
// Load a CRT file from a File object (for file input)
// @param {File} file - File object from input element
// @returns {Promise<Cartridge>} Loaded cartridge
//
export async function loadCRTFromFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = (e) => {
            const cartridge = new Cartridge();
            if (cartridge.load(e.target.result)) {
                resolve(cartridge);
            } else {
                reject(new Error('Failed to parse CRT file'));
            }
        };

        reader.onerror = () => {
            reject(new Error('Failed to read file'));
        };

        reader.readAsArrayBuffer(file);
    });
}
