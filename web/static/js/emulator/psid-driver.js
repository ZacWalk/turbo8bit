//
// @fileoverview PSID Driver - Minimal driver for SID file playback
// @module emulator/psid-driver
//
// This module generates the PSID driver code for C64 SID playback.
// The driver handles the init/play routines, interrupt handling, and memory banking
// required to play PSID/RSID files in the C64 emulator.
//
// Architecture:
//   SID file → parseSidFile() → tune metadata
//                                    ↓
//   generatePsidDriver() → driver bytes + memory layout info
//                                    ↓
//   sid-player.js → installs driver into C64Machine
//                                    ↓
//   IRQ-driven playback via CIA/VIC timing
//
// @see https://www.turbo8bit.com/
//

import { CLOCK_NTSC } from './machine.js';

//
// Driver memory addresses (exported for use by sid-player.js)
//
export const DRIVER_ADDRESS = 0x0400;      // Main driver location (screen RAM)
export const IRQ_HANDLER_ADDRESS = 0x0390; // IRQ handler in low RAM
export const NMI_HANDLER_ADDRESS = 0x0380; // NMI handler in low RAM
export const IRQ_FULL_ADDRESS = 0x03B0;    // Full IRQ handler (saves registers)

//
// Generate a minimal PSID driver for SID file playback
//
// IMPORTANT: This driver disables the KERNAL ROM and handles interrupts directly
// in RAM. This is necessary because the ROM files may not be loaded for SID playback,
// and the CPU would crash when trying to use the KERNAL's interrupt handler.
//
// This driver:
// 1. Disables KERNAL ROM by setting memory config to $35 (I/O visible, ROMs off)
// 2. Installs IRQ/NMI handlers directly in RAM at hardware vector locations
// 3. Clears pending interrupts
// 4. Sets up CIA1 timer for proper play rate (50Hz PAL / 60Hz NTSC)
// 5. Calls the init routine with song number in A
// 6. Enables interrupts and enters idle loop
//
// Returns an object with byte arrays and addresses for each memory region.
// The caller (sid-player.js) is responsible for installing these into the machine.
//
// @param {Object} tune - Parsed SID tune info
// @param {number} song - Song number (0-based)
// @returns {Object} Driver data with:
//   - regions: Array of {address, data} objects for memory regions
//   - ioPort: Value for $0001 (memory configuration)
//   - cpuState: Initial CPU state {PC, A, X, Y, SP, P}
//
export function generatePsidDriver(tune, song) {
    // Determine timing: bit in speed field indicates CIA (1) or VIC (0)
    const useCIA = (tune.speed >> song) & 1;
    const isNTSC = tune.clock === CLOCK_NTSC;

    // Calculate timer value for 50Hz (PAL) or 60Hz (NTSC)
    const timerValue = isNTSC ? 0x4295 : 0x4025;

    // Store init and play addresses for the driver
    const initAddr = tune.initAddress;
    const playAddr = tune.playAddress;

    // Calculate I/O map values based on address ranges
    const calcIoMap = (addr) => {
        if (tune.isRSID || addr === 0) {
            return 0x37;
        }
        if (addr < 0xA000) return 0x37;
        if (addr < 0xD000) return 0x36;
        if (addr >= 0xE000) return 0x35;
        return 0x34;
    };

    const initIoMap = calcIoMap(initAddr);
    const playIoMap = calcIoMap(playAddr);

    // Collect all memory regions to install
    const regions = [];

    // ========================================
    // NMI Handler at $0380
    // ========================================
    const nmiHandlerData = [0x40];  // RTI
    regions.push({ address: NMI_HANDLER_ADDRESS, data: nmiHandlerData });

    // ========================================
    // IRQ Simple Handler at $0390
    // ========================================
    const irqSimpleData = [];

    if (playAddr !== 0) {
        // Save current bank: LDA $01, PHA
        irqSimpleData.push(0xA5, 0x01);  // LDA $01
        irqSimpleData.push(0x48);        // PHA

        // Set play I/O map: LDA #playIoMap, STA $01
        irqSimpleData.push(0xA9, playIoMap);  // LDA #playIoMap
        irqSimpleData.push(0x85, 0x01);       // STA $01

        // LDA #$00 (for play routine - some expect this)
        irqSimpleData.push(0xA9, 0x00);

        // JSR playAddr
        irqSimpleData.push(0x20);
        irqSimpleData.push(playAddr & 0xFF);
        irqSimpleData.push((playAddr >> 8) & 0xFF);

        // Restore bank: PLA, STA $01
        irqSimpleData.push(0x68);        // PLA
        irqSimpleData.push(0x85, 0x01);  // STA $01

        // Acknowledge VIC IRQ: LDA #$FF, STA $D019
        irqSimpleData.push(0xA9, 0xFF);           // LDA #$FF
        irqSimpleData.push(0x8D, 0x19, 0xD0);     // STA $D019

        // Acknowledge CIA1 interrupt: LDA $DC0D
        irqSimpleData.push(0xAD, 0x0D, 0xDC);

        // Restore Y, X, A (pushed by KERNAL)
        irqSimpleData.push(0x68);  // PLA
        irqSimpleData.push(0xA8);  // TAY
        irqSimpleData.push(0x68);  // PLA
        irqSimpleData.push(0xAA);  // TAX
        irqSimpleData.push(0x68);  // PLA

        // RTI
        irqSimpleData.push(0x40);
    } else {
        // RSID - just acknowledge and return
        irqSimpleData.push(0xA9, 0xFF);           // LDA #$FF
        irqSimpleData.push(0x8D, 0x19, 0xD0);     // STA $D019
        irqSimpleData.push(0xAD, 0x0D, 0xDC);     // LDA $DC0D
        irqSimpleData.push(0x68);  // PLA
        irqSimpleData.push(0xA8);  // TAY
        irqSimpleData.push(0x68);  // PLA
        irqSimpleData.push(0xAA);  // TAX
        irqSimpleData.push(0x68);  // PLA
        irqSimpleData.push(0x40);  // RTI
    }
    regions.push({ address: IRQ_HANDLER_ADDRESS, data: irqSimpleData });

    // ========================================
    // IRQ Full Handler at $03B0
    // ========================================
    const irqFullData = [];

    // Save A, X, Y first
    irqFullData.push(0x48);  // PHA - save A
    irqFullData.push(0x8A);  // TXA
    irqFullData.push(0x48);  // PHA - save X
    irqFullData.push(0x98);  // TYA
    irqFullData.push(0x48);  // PHA - save Y

    if (playAddr !== 0) {
        // Save current bank: LDA $01, PHA
        irqFullData.push(0xA5, 0x01);  // LDA $01
        irqFullData.push(0x48);        // PHA

        // Set play I/O map
        irqFullData.push(0xA9, playIoMap);  // LDA #playIoMap
        irqFullData.push(0x85, 0x01);       // STA $01

        // LDA #$00
        irqFullData.push(0xA9, 0x00);

        // JSR playAddr
        irqFullData.push(0x20);
        irqFullData.push(playAddr & 0xFF);
        irqFullData.push((playAddr >> 8) & 0xFF);

        // Restore bank: PLA, STA $01
        irqFullData.push(0x68);        // PLA
        irqFullData.push(0x85, 0x01);  // STA $01
    }

    // Acknowledge VIC IRQ
    irqFullData.push(0xA9, 0xFF);           // LDA #$FF
    irqFullData.push(0x8D, 0x19, 0xD0);     // STA $D019

    // Acknowledge CIA1
    irqFullData.push(0xAD, 0x0D, 0xDC);

    // Restore Y, X, A
    irqFullData.push(0x68);  // PLA
    irqFullData.push(0xA8);  // TAY
    irqFullData.push(0x68);  // PLA
    irqFullData.push(0xAA);  // TAX
    irqFullData.push(0x68);  // PLA

    // RTI
    irqFullData.push(0x40);

    regions.push({ address: IRQ_FULL_ADDRESS, data: irqFullData });

    // ========================================
    // Main Driver at $0400
    // ========================================
    const driverData = [];

    // SEI - disable interrupts during setup
    driverData.push(0x78);

    // Clear VIC IRQ: LDA #$00, STA $D01A
    driverData.push(0xA9, 0x00);
    driverData.push(0x8D, 0x1A, 0xD0);

    // Acknowledge VIC IRQ: LDA $D019, STA $D019
    driverData.push(0xAD, 0x19, 0xD0);
    driverData.push(0x8D, 0x19, 0xD0);

    // Clear CIA interrupts: LDA #$7F, STA $DC0D, STA $DD0D
    driverData.push(0xA9, 0x7F);
    driverData.push(0x8D, 0x0D, 0xDC);
    driverData.push(0x8D, 0x0D, 0xDD);

    // Acknowledge CIA interrupts: LDA $DC0D, LDA $DD0D
    driverData.push(0xAD, 0x0D, 0xDC);
    driverData.push(0xAD, 0x0D, 0xDD);

    // Set maximum volume: LDA #$0F, STA $D418
    driverData.push(0xA9, 0x0F);
    driverData.push(0x8D, 0x18, 0xD4);

    // Set CIA1 Timer A: LDA #lo, STA $DC04, LDA #hi, STA $DC05
    driverData.push(0xA9, timerValue & 0xFF);
    driverData.push(0x8D, 0x04, 0xDC);
    driverData.push(0xA9, (timerValue >> 8) & 0xFF);
    driverData.push(0x8D, 0x05, 0xDC);

    // Set I/O map before calling init
    driverData.push(0xA9, initIoMap);  // LDA #initIoMap
    driverData.push(0x85, 0x01);       // STA $01

    // Call init routine: LDA #song, JSR initAddr
    driverData.push(0xA9, song);
    driverData.push(0x20);
    driverData.push(initAddr & 0xFF);
    driverData.push((initAddr >> 8) & 0xFF);

    // After init returns, set bank back to $37
    driverData.push(0xA9, 0x37);       // LDA #$37
    driverData.push(0x85, 0x01);       // STA $01

    // Set up interrupt source based on timing (VIC raster vs CIA timer)
    if (playAddr !== 0) {
        // Normal PSID: we set up both IRQ enable and start the timer
        if (useCIA) {
            // CIA timing: Enable CIA1 Timer A interrupt
            driverData.push(0xA9, 0x81);
            driverData.push(0x8D, 0x0D, 0xDC);

            // Start CIA1 Timer A
            driverData.push(0xA9, 0x01);
            driverData.push(0x8D, 0x0E, 0xDC);
        } else {
            // VIC timing: Set up raster compare and enable VIC raster interrupt
            driverData.push(0xA9, 0x1B);
            driverData.push(0x8D, 0x11, 0xD0);

            driverData.push(0xA9, 0x00);
            driverData.push(0x8D, 0x12, 0xD0);

            driverData.push(0xA9, 0x01);
            driverData.push(0x8D, 0x1A, 0xD0);
        }
    } else {
        // RSID with playAddress=0: the tune sets up its own IRQ handler
        // But many RSID tunes expect CIA1 Timer A to be running (like KERNAL leaves it)
        // So we just start the timer without enabling the IRQ - the tune handles IRQ enable
        driverData.push(0xA9, 0x01);       // LDA #$01
        driverData.push(0x8D, 0x0E, 0xDC); // STA $DC0E - Start CIA1 Timer A
    }

    // CLI - enable interrupts
    driverData.push(0x58);

    // Idle loop: JMP to itself
    const idleLoopOffset = DRIVER_ADDRESS + driverData.length;
    driverData.push(0x4C);  // JMP
    driverData.push(idleLoopOffset & 0xFF);
    driverData.push((idleLoopOffset >> 8) & 0xFF);

    regions.push({ address: DRIVER_ADDRESS, data: driverData });

    // ========================================
    // Hardware Vectors at $FFFA-$FFFF
    // ========================================
    const vectorsData = [
        NMI_HANDLER_ADDRESS & 0xFF,           // $FFFA - NMI low
        (NMI_HANDLER_ADDRESS >> 8) & 0xFF,    // $FFFB - NMI high
        DRIVER_ADDRESS & 0xFF,                // $FFFC - RESET low
        (DRIVER_ADDRESS >> 8) & 0xFF,         // $FFFD - RESET high
        IRQ_FULL_ADDRESS & 0xFF,              // $FFFE - IRQ low
        (IRQ_FULL_ADDRESS >> 8) & 0xFF        // $FFFF - IRQ high
    ];
    regions.push({ address: 0xFFFA, data: vectorsData });

    // ========================================
    // Software Vectors at $0314-$0319
    // ========================================
    const softwareVectorsData = [
        IRQ_HANDLER_ADDRESS & 0xFF,           // $0314 - IRQ low
        (IRQ_HANDLER_ADDRESS >> 8) & 0xFF,    // $0315 - IRQ high
        IRQ_HANDLER_ADDRESS & 0xFF,           // $0316 - BRK low
        (IRQ_HANDLER_ADDRESS >> 8) & 0xFF,    // $0317 - BRK high
        NMI_HANDLER_ADDRESS & 0xFF,           // $0318 - NMI low
        (NMI_HANDLER_ADDRESS >> 8) & 0xFF     // $0319 - NMI high
    ];
    regions.push({ address: 0x0314, data: softwareVectorsData });

    // Return the driver data
    return {
        regions: regions,
        ioPort: 0x35,  // Memory configuration (I/O visible, ROMs off for vectors)
        cpuState: {
            PC: DRIVER_ADDRESS,
            A: song,
            X: 0,
            Y: 0,
            SP: 0xFF,
            P: 0x04  // Interrupts disabled initially
        },
        debug: {
            initAddr,
            playAddr,
            initIoMap,
            playIoMap,
            useCIA,
            timerValue
        }
    };
}
