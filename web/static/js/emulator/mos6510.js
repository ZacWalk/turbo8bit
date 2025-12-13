//
// @fileoverview MOS 6510 CPU Emulation - Cycle-exact 6502/6510 processor
// @module emulator/mos6510
//
// Cycle-exact emulation of the MOS 6510 CPU used in the Commodore 64.
// The 6510 is a variant of the 6502 with an integrated I/O port at $0000-$0001.
// Inspired by libsidplayfp.
//
// Features:
// - All official 6502 opcodes (151 instructions)
// - Accurate cycle counting for each instruction
// - IRQ and NMI interrupt handling
// - Bus interface for memory-mapped I/O
//
// The CPU requires a Bus interface object with read(addr) and write(addr, val) methods.
//
// Status register flags:
// - N (Negative), V (Overflow), B (Break), D (Decimal)
// - I (Interrupt disable), Z (Zero), C (Carry)
//
// For full C64 machine, see machine.js.
//
// @see https://www.turbo8bit.com/
//

// Status register flags
export const FLAG_N = 0x80; // Negative
export const FLAG_V = 0x40; // Overflow
export const FLAG_B = 0x10; // Break
export const FLAG_D = 0x08; // Decimal
export const FLAG_I = 0x04; // Interrupt disable
export const FLAG_Z = 0x02; // Zero
export const FLAG_C = 0x01; // Carry

export class MOS6510 {
    //
    // Create a new MOS6510 CPU instance.
    // @param {Object} bus - Bus interface with read(addr) and write(addr, val) methods.
    //
    constructor(bus) {
        this.bus = bus;

        // Registers
        this.PC = 0;      // Program Counter
        this.A = 0;       // Accumulator
        this.X = 0;       // X Index
        this.Y = 0;       // Y Index
        this.SP = 0xff;   // Stack Pointer
        this.P = 0x24;    // Processor Status (I flag set, unused bit set)

        // Cycle counter
        this.cycles = 0;

        // IRQ/NMI flags
        this.irqPending = false;
        this.nmiPending = false;

        // Halt flag for JAM instructions
        this.halted = false;
    }

    //
    // Reset the CPU
    //
    reset() {
        this.A = 0;
        this.X = 0;
        this.Y = 0;
        this.SP = 0xff;
        this.P = 0x24;
        this.cycles = 0;
        this.halted = false;
        this.irqPending = false;
        this.nmiPending = false;

        // Load reset vector
        this.PC = this.read(0xfffc) | (this.read(0xfffd) << 8);
    }

    //
    // Read a byte from memory via Bus
    //
    read(addr) {
        return this.bus.read(addr & 0xffff);
    }

    //
    // Write a byte to memory via Bus
    //
    write(addr, value) {
        this.bus.write(addr & 0xffff, value & 0xff);
    }

    //
    // Push a byte onto the stack
    //
    push(value) {
        this.write(0x0100 + this.SP, value);
        this.SP = (this.SP - 1) & 0xff;
    }

    //
    // Pop a byte from the stack
    //
    pop() {
        this.SP = (this.SP + 1) & 0xff;
        return this.read(0x0100 + this.SP);
    }

    //
    // Set/clear flags based on result
    //
    setNZ(value) {
        this.P &= ~(FLAG_N | FLAG_Z);
        if (value === 0) this.P |= FLAG_Z;
        if (value & 0x80) this.P |= FLAG_N;
        return value;
    }

    //
    // Trigger IRQ
    //
    triggerIRQ() {
        this.irqPending = true;
    }

    //
    // Trigger NMI
    //
    triggerNMI() {
        this.nmiPending = true;
    }

    //
    // Clear IRQ
    //
    clearIRQ() {
        this.irqPending = false;
    }

    //
    // Handle interrupts
    //
    handleInterrupt() {
        if (this.nmiPending) {
            this.nmiPending = false;
            this.push((this.PC >> 8) & 0xff);
            this.push(this.PC & 0xff);
            this.push(this.P & ~FLAG_B);
            this.P |= FLAG_I;
            const vectorLo = this.read(0xfffa);
            const vectorHi = this.read(0xfffb);
            const vector = vectorLo | (vectorHi << 8);
            this.PC = vector;
            this.cycles += 7;
            return true;
        }

        if (this.irqPending && !(this.P & FLAG_I)) {
            this.push((this.PC >> 8) & 0xff);
            this.push(this.PC & 0xff);
            this.push(this.P & ~FLAG_B);
            this.P |= FLAG_I;
            this.PC = this.read(0xfffe) | (this.read(0xffff) << 8);
            this.cycles += 7;
            return true;
        }

        return false;
    }

    //
    // Execute one instruction
    // @returns {number} Cycles consumed
    //
    step() {
        if (this.halted) return 1;

        const startCycles = this.cycles;

        // Check for interrupts
        if (this.handleInterrupt()) {
            return this.cycles - startCycles;
        }

        // Fetch opcode
        const opcode = this.read(this.PC++);

        if (window.debugCPU) {
            console.log(`Step PC=${(this.PC - 1).toString(16)} Op=${opcode.toString(16)}`);
        }

        // Execute instruction
        this.executeOpcode(opcode);

        return this.cycles - startCycles;
    }

    //
    // Execute a specific opcode
    //
    executeOpcode(opcode) {
        switch (opcode) {
            // BRK
            case 0x00: this.brk(); break;

            // ORA
            case 0x01: this.ora(this.addrIndirectX()); break;
            case 0x05: this.ora(this.addrZeroPage()); break;
            case 0x09: this.ora(this.addrImmediate()); break;
            case 0x0d: this.ora(this.addrAbsolute()); break;
            case 0x11: this.ora(this.addrIndirectY()); break;
            case 0x15: this.ora(this.addrZeroPageX()); break;
            case 0x19: this.ora(this.addrAbsoluteY()); break;
            case 0x1d: this.ora(this.addrAbsoluteX()); break;

            // ASL
            case 0x06: this.aslMem(this.addrZeroPage()); break;
            case 0x0a: this.aslA(); break;
            case 0x0e: this.aslMem(this.addrAbsolute()); break;
            case 0x16: this.aslMem(this.addrZeroPageX()); break;
            case 0x1e: this.aslMem(this.addrAbsoluteX()); break;

            // PHP
            case 0x08: this.php(); break;

            // BPL
            case 0x10: this.branch(!(this.P & FLAG_N)); break;

            // CLC
            case 0x18: this.P &= ~FLAG_C; this.cycles += 2; break;

            // JSR
            case 0x20: this.jsr(); break;

            // AND
            case 0x21: this.and(this.addrIndirectX()); break;
            case 0x25: this.and(this.addrZeroPage()); break;
            case 0x29: this.and(this.addrImmediate()); break;
            case 0x2d: this.and(this.addrAbsolute()); break;
            case 0x31: this.and(this.addrIndirectY()); break;
            case 0x35: this.and(this.addrZeroPageX()); break;
            case 0x39: this.and(this.addrAbsoluteY()); break;
            case 0x3d: this.and(this.addrAbsoluteX()); break;

            // BIT
            case 0x24: this.bit(this.addrZeroPage()); break;
            case 0x2c: this.bit(this.addrAbsolute()); break;

            // ROL
            case 0x26: this.rolMem(this.addrZeroPage()); break;
            case 0x2a: this.rolA(); break;
            case 0x2e: this.rolMem(this.addrAbsolute()); break;
            case 0x36: this.rolMem(this.addrZeroPageX()); break;
            case 0x3e: this.rolMem(this.addrAbsoluteX()); break;

            // PLP
            case 0x28: this.plp(); break;

            // BMI
            case 0x30: this.branch(!!(this.P & FLAG_N)); break;

            // SEC
            case 0x38: this.P |= FLAG_C; this.cycles += 2; break;

            // RTI
            case 0x40: this.rti(); break;

            // EOR
            case 0x41: this.eor(this.addrIndirectX()); break;
            case 0x45: this.eor(this.addrZeroPage()); break;
            case 0x49: this.eor(this.addrImmediate()); break;
            case 0x4d: this.eor(this.addrAbsolute()); break;
            case 0x51: this.eor(this.addrIndirectY()); break;
            case 0x55: this.eor(this.addrZeroPageX()); break;
            case 0x59: this.eor(this.addrAbsoluteY()); break;
            case 0x5d: this.eor(this.addrAbsoluteX()); break;

            // LSR
            case 0x46: this.lsrMem(this.addrZeroPage()); break;
            case 0x4a: this.lsrA(); break;
            case 0x4e: this.lsrMem(this.addrAbsolute()); break;
            case 0x56: this.lsrMem(this.addrZeroPageX()); break;
            case 0x5e: this.lsrMem(this.addrAbsoluteX()); break;

            // PHA
            case 0x48: this.push(this.A); this.cycles += 3; break;

            // JMP
            case 0x4c: this.PC = this.addrAbsolute(); this.cycles += 3; break;
            case 0x6c: this.jmpIndirect(); break;

            // BVC
            case 0x50: this.branch(!(this.P & FLAG_V)); break;

            // CLI
            case 0x58: this.P &= ~FLAG_I; this.cycles += 2; break;

            // RTS
            case 0x60: this.rts(); break;

            // ADC
            case 0x61: this.adc(this.addrIndirectX()); break;
            case 0x65: this.adc(this.addrZeroPage()); break;
            case 0x69: this.adc(this.addrImmediate()); break;
            case 0x6d: this.adc(this.addrAbsolute()); break;
            case 0x71: this.adc(this.addrIndirectY()); break;
            case 0x75: this.adc(this.addrZeroPageX()); break;
            case 0x79: this.adc(this.addrAbsoluteY()); break;
            case 0x7d: this.adc(this.addrAbsoluteX()); break;

            // ROR
            case 0x66: this.rorMem(this.addrZeroPage()); break;
            case 0x6a: this.rorA(); break;
            case 0x6e: this.rorMem(this.addrAbsolute()); break;
            case 0x76: this.rorMem(this.addrZeroPageX()); break;
            case 0x7e: this.rorMem(this.addrAbsoluteX()); break;

            // PLA
            case 0x68: this.A = this.setNZ(this.pop()); this.cycles += 4; break;

            // BVS
            case 0x70: this.branch(!!(this.P & FLAG_V)); break;

            // SEI
            case 0x78: this.P |= FLAG_I; this.cycles += 2; break;

            // STA
            case 0x81: this.write(this.addrIndirectX(), this.A); this.cycles += 6; break;
            case 0x85: this.write(this.addrZeroPage(), this.A); this.cycles += 3; break;
            case 0x8d: this.write(this.addrAbsolute(), this.A); this.cycles += 4; break;
            case 0x91: this.write(this.addrIndirectYStore(), this.A); this.cycles += 6; break;
            case 0x95: this.write(this.addrZeroPageX(), this.A); this.cycles += 4; break;
            case 0x99: this.write(this.addrAbsoluteYStore(), this.A); this.cycles += 5; break;
            case 0x9d: this.write(this.addrAbsoluteXStore(), this.A); this.cycles += 5; break;

            // STY
            case 0x84: this.write(this.addrZeroPage(), this.Y); this.cycles += 3; break;
            case 0x8c: this.write(this.addrAbsolute(), this.Y); this.cycles += 4; break;
            case 0x94: this.write(this.addrZeroPageX(), this.Y); this.cycles += 4; break;

            // STX
            case 0x86: this.write(this.addrZeroPage(), this.X); this.cycles += 3; break;
            case 0x8e: this.write(this.addrAbsolute(), this.X); this.cycles += 4; break;
            case 0x96: this.write(this.addrZeroPageY(), this.X); this.cycles += 4; break;

            // DEY
            case 0x88: this.Y = this.setNZ((this.Y - 1) & 0xff); this.cycles += 2; break;

            // TXA
            case 0x8a: this.A = this.setNZ(this.X); this.cycles += 2; break;

            // BCC
            case 0x90: this.branch(!(this.P & FLAG_C)); break;

            // TYA
            case 0x98: this.A = this.setNZ(this.Y); this.cycles += 2; break;

            // TXS
            case 0x9a: this.SP = this.X; this.cycles += 2; break;

            // LDY
            case 0xa0: this.Y = this.setNZ(this.read(this.addrImmediate())); this.cycles += 2; break;
            case 0xa4: this.Y = this.setNZ(this.read(this.addrZeroPage())); this.cycles += 3; break;
            case 0xac: this.Y = this.setNZ(this.read(this.addrAbsolute())); this.cycles += 4; break;
            case 0xb4: this.Y = this.setNZ(this.read(this.addrZeroPageX())); this.cycles += 4; break;
            case 0xbc: this.Y = this.setNZ(this.read(this.addrAbsoluteX())); break;

            // LDA
            case 0xa1: this.A = this.setNZ(this.read(this.addrIndirectX())); this.cycles += 6; break;
            case 0xa5: this.A = this.setNZ(this.read(this.addrZeroPage())); this.cycles += 3; break;
            case 0xa9: this.A = this.setNZ(this.read(this.addrImmediate())); this.cycles += 2; break;
            case 0xad: this.A = this.setNZ(this.read(this.addrAbsolute())); this.cycles += 4; break;
            case 0xb1: this.A = this.setNZ(this.read(this.addrIndirectY())); break;
            case 0xb5: this.A = this.setNZ(this.read(this.addrZeroPageX())); this.cycles += 4; break;
            case 0xb9: this.A = this.setNZ(this.read(this.addrAbsoluteY())); break;
            case 0xbd: this.A = this.setNZ(this.read(this.addrAbsoluteX())); break;

            // LDX
            case 0xa2: this.X = this.setNZ(this.read(this.addrImmediate())); this.cycles += 2; break;
            case 0xa6: this.X = this.setNZ(this.read(this.addrZeroPage())); this.cycles += 3; break;
            case 0xae: this.X = this.setNZ(this.read(this.addrAbsolute())); this.cycles += 4; break;
            case 0xb6: this.X = this.setNZ(this.read(this.addrZeroPageY())); this.cycles += 4; break;
            case 0xbe: this.X = this.setNZ(this.read(this.addrAbsoluteY())); break;

            // TAY
            case 0xa8: this.Y = this.setNZ(this.A); this.cycles += 2; break;

            // TAX
            case 0xaa: this.X = this.setNZ(this.A); this.cycles += 2; break;

            // BCS
            case 0xb0: this.branch(!!(this.P & FLAG_C)); break;

            // CLV
            case 0xb8: this.P &= ~FLAG_V; this.cycles += 2; break;

            // TSX
            case 0xba: this.X = this.setNZ(this.SP); this.cycles += 2; break;

            // CPY
            case 0xc0: this.cmp(this.Y, this.read(this.addrImmediate())); this.cycles += 2; break;
            case 0xc4: this.cmp(this.Y, this.read(this.addrZeroPage())); this.cycles += 3; break;
            case 0xcc: this.cmp(this.Y, this.read(this.addrAbsolute())); this.cycles += 4; break;

            // CMP
            case 0xc1: this.cmp(this.A, this.read(this.addrIndirectX())); this.cycles += 6; break;
            case 0xc5: this.cmp(this.A, this.read(this.addrZeroPage())); this.cycles += 3; break;
            case 0xc9: this.cmp(this.A, this.read(this.addrImmediate())); this.cycles += 2; break;
            case 0xcd: this.cmp(this.A, this.read(this.addrAbsolute())); this.cycles += 4; break;
            case 0xd1: this.cmp(this.A, this.read(this.addrIndirectY())); break;
            case 0xd5: this.cmp(this.A, this.read(this.addrZeroPageX())); this.cycles += 4; break;
            case 0xd9: this.cmp(this.A, this.read(this.addrAbsoluteY())); break;
            case 0xdd: this.cmp(this.A, this.read(this.addrAbsoluteX())); break;

            // DEC
            case 0xc6: this.decMem(this.addrZeroPage()); break;
            case 0xce: this.decMem(this.addrAbsolute()); break;
            case 0xd6: this.decMem(this.addrZeroPageX()); break;
            case 0xde: this.decMem(this.addrAbsoluteX()); break;

            // INY
            case 0xc8: this.Y = this.setNZ((this.Y + 1) & 0xff); this.cycles += 2; break;

            // DEX
            case 0xca: this.X = this.setNZ((this.X - 1) & 0xff); this.cycles += 2; break;

            // BNE
            case 0xd0: this.branch(!(this.P & FLAG_Z)); break;

            // CLD
            case 0xd8: this.P &= ~FLAG_D; this.cycles += 2; break;

            // CPX
            case 0xe0: this.cmp(this.X, this.read(this.addrImmediate())); this.cycles += 2; break;
            case 0xe4: this.cmp(this.X, this.read(this.addrZeroPage())); this.cycles += 3; break;
            case 0xec: this.cmp(this.X, this.read(this.addrAbsolute())); this.cycles += 4; break;

            // SBC
            case 0xe1: this.sbc(this.addrIndirectX()); break;
            case 0xe5: this.sbc(this.addrZeroPage()); break;
            case 0xe9: this.sbc(this.addrImmediate()); break;
            case 0xeb: this.sbc(this.addrImmediate()); break; // Undocumented
            case 0xed: this.sbc(this.addrAbsolute()); break;
            case 0xf1: this.sbc(this.addrIndirectY()); break;
            case 0xf5: this.sbc(this.addrZeroPageX()); break;
            case 0xf9: this.sbc(this.addrAbsoluteY()); break;
            case 0xfd: this.sbc(this.addrAbsoluteX()); break;

            // INC
            case 0xe6: this.incMem(this.addrZeroPage()); break;
            case 0xee: this.incMem(this.addrAbsolute()); break;
            case 0xf6: this.incMem(this.addrZeroPageX()); break;
            case 0xfe: this.incMem(this.addrAbsoluteX()); break;

            // INX
            case 0xe8: this.X = this.setNZ((this.X + 1) & 0xff); this.cycles += 2; break;

            // NOP
            case 0xea: this.cycles += 2; break;

            // BEQ
            case 0xf0: this.branch(!!(this.P & FLAG_Z)); break;

            // SED
            case 0xf8: this.P |= FLAG_D; this.cycles += 2; break;

            // Undocumented NOPs
            case 0x1a: case 0x3a: case 0x5a: case 0x7a: case 0xda: case 0xfa:
                this.cycles += 2; break;
            case 0x04: case 0x44: case 0x64:
                this.PC++; this.cycles += 3; break;
            case 0x0c:
                this.PC += 2; this.cycles += 4; break;
            case 0x14: case 0x34: case 0x54: case 0x74: case 0xd4: case 0xf4:
                this.PC++; this.cycles += 4; break;
            case 0x1c: case 0x3c: case 0x5c: case 0x7c: case 0xdc: case 0xfc:
                this.addrAbsoluteX(); break;
            case 0x80: case 0x82: case 0x89: case 0xc2: case 0xe2:
                this.PC++; this.cycles += 2; break;

            // Undocumented LAX (LDA + LDX)
            case 0xa3: { const v = this.read(this.addrIndirectX()); this.A = this.X = this.setNZ(v); this.cycles += 6; break; }
            case 0xa7: { const v = this.read(this.addrZeroPage()); this.A = this.X = this.setNZ(v); this.cycles += 3; break; }
            case 0xaf: { const v = this.read(this.addrAbsolute()); this.A = this.X = this.setNZ(v); this.cycles += 4; break; }
            case 0xb3: { const v = this.read(this.addrIndirectY()); this.A = this.X = this.setNZ(v); break; }
            case 0xb7: { const v = this.read(this.addrZeroPageY()); this.A = this.X = this.setNZ(v); this.cycles += 4; break; }
            case 0xbf: { const v = this.read(this.addrAbsoluteY()); this.A = this.X = this.setNZ(v); break; }

            // Undocumented SAX (store A & X)
            case 0x83: this.write(this.addrIndirectX(), this.A & this.X); this.cycles += 6; break;
            case 0x87: this.write(this.addrZeroPage(), this.A & this.X); this.cycles += 3; break;
            case 0x8f: this.write(this.addrAbsolute(), this.A & this.X); this.cycles += 4; break;
            case 0x97: this.write(this.addrZeroPageY(), this.A & this.X); this.cycles += 4; break;

            // Undocumented SHY (store Y & (high byte + 1))
            case 0x9c: { const addr = this.addrAbsoluteXStore(); this.write(addr, this.Y & ((addr >> 8) + 1)); this.cycles += 5; break; }

            // Undocumented SHX (store X & (high byte + 1))
            case 0x9e: { const addr = this.addrAbsoluteYStore(); this.write(addr, this.X & ((addr >> 8) + 1)); this.cycles += 5; break; }

            // Undocumented TAS/SHS (A & X -> SP, then store A & X & (high byte + 1))
            case 0x9b: { this.SP = this.A & this.X; const addr = this.addrAbsoluteYStore(); this.write(addr, this.SP & ((addr >> 8) + 1)); this.cycles += 5; break; }

            // Undocumented SHA/AHX (store A & X & (high byte + 1))
            case 0x93: { const addr = this.addrIndirectYStore(); this.write(addr, this.A & this.X & ((addr >> 8) + 1)); this.cycles += 6; break; }
            case 0x9f: { const addr = this.addrAbsoluteYStore(); this.write(addr, this.A & this.X & ((addr >> 8) + 1)); this.cycles += 5; break; }

            // Undocumented DCP (DEC + CMP)
            case 0xc3: this.dcp(this.addrIndirectX()); this.cycles += 8; break;
            case 0xc7: this.dcp(this.addrZeroPage()); this.cycles += 5; break;
            case 0xcf: this.dcp(this.addrAbsolute()); this.cycles += 6; break;
            case 0xd3: this.dcp(this.addrIndirectYStore()); this.cycles += 8; break;
            case 0xd7: this.dcp(this.addrZeroPageX()); this.cycles += 6; break;
            case 0xdb: this.dcp(this.addrAbsoluteYStore()); this.cycles += 7; break;
            case 0xdf: this.dcp(this.addrAbsoluteXStore()); this.cycles += 7; break;

            // Undocumented ISB/ISC (INC + SBC)
            case 0xe3: this.isb(this.addrIndirectX()); this.cycles += 8; break;
            case 0xe7: this.isb(this.addrZeroPage()); this.cycles += 5; break;
            case 0xef: this.isb(this.addrAbsolute()); this.cycles += 6; break;
            case 0xf3: this.isb(this.addrIndirectYStore()); this.cycles += 8; break;
            case 0xf7: this.isb(this.addrZeroPageX()); this.cycles += 6; break;
            case 0xfb: this.isb(this.addrAbsoluteYStore()); this.cycles += 7; break;
            case 0xff: this.isb(this.addrAbsoluteXStore()); this.cycles += 7; break;

            // Undocumented SLO (ASL + ORA)
            case 0x03: this.slo(this.addrIndirectX()); this.cycles += 8; break;
            case 0x07: this.slo(this.addrZeroPage()); this.cycles += 5; break;
            case 0x0f: this.slo(this.addrAbsolute()); this.cycles += 6; break;
            case 0x13: this.slo(this.addrIndirectYStore()); this.cycles += 8; break;
            case 0x17: this.slo(this.addrZeroPageX()); this.cycles += 6; break;
            case 0x1b: this.slo(this.addrAbsoluteYStore()); this.cycles += 7; break;
            case 0x1f: this.slo(this.addrAbsoluteXStore()); this.cycles += 7; break;

            // Undocumented RLA (ROL + AND)
            case 0x23: this.rla(this.addrIndirectX()); this.cycles += 8; break;
            case 0x27: this.rla(this.addrZeroPage()); this.cycles += 5; break;
            case 0x2f: this.rla(this.addrAbsolute()); this.cycles += 6; break;
            case 0x33: this.rla(this.addrIndirectYStore()); this.cycles += 8; break;
            case 0x37: this.rla(this.addrZeroPageX()); this.cycles += 6; break;
            case 0x3b: this.rla(this.addrAbsoluteYStore()); this.cycles += 7; break;
            case 0x3f: this.rla(this.addrAbsoluteXStore()); this.cycles += 7; break;

            // Undocumented SRE (LSR + EOR)
            case 0x43: this.sre(this.addrIndirectX()); this.cycles += 8; break;
            case 0x47: this.sre(this.addrZeroPage()); this.cycles += 5; break;
            case 0x4f: this.sre(this.addrAbsolute()); this.cycles += 6; break;
            case 0x53: this.sre(this.addrIndirectYStore()); this.cycles += 8; break;
            case 0x57: this.sre(this.addrZeroPageX()); this.cycles += 6; break;
            case 0x5b: this.sre(this.addrAbsoluteYStore()); this.cycles += 7; break;
            case 0x5f: this.sre(this.addrAbsoluteXStore()); this.cycles += 7; break;

            // Undocumented RRA (ROR + ADC)
            case 0x63: this.rra(this.addrIndirectX()); this.cycles += 8; break;
            case 0x67: this.rra(this.addrZeroPage()); this.cycles += 5; break;
            case 0x6f: this.rra(this.addrAbsolute()); this.cycles += 6; break;
            case 0x73: this.rra(this.addrIndirectYStore()); this.cycles += 8; break;
            case 0x77: this.rra(this.addrZeroPageX()); this.cycles += 6; break;
            case 0x7b: this.rra(this.addrAbsoluteYStore()); this.cycles += 7; break;
            case 0x7f: this.rra(this.addrAbsoluteXStore()); this.cycles += 7; break;

            // JAM/KIL (halt CPU)
            case 0x02: case 0x12: case 0x22: case 0x32: case 0x42: case 0x52:
            case 0x62: case 0x72: case 0x92: case 0xb2: case 0xd2: case 0xf2:
                this.halted = true;
                this.cycles += 2;
                break;

            default:
                // Unknown opcode - treat as NOP
                console.warn(`Unknown opcode: $${opcode.toString(16)} at $${(this.PC - 1).toString(16)}`);
                this.cycles += 2;
                break;
        }
    }

    // Addressing modes

    addrImmediate() {
        return this.PC++;
    }

    addrZeroPage() {
        return this.read(this.PC++);
    }

    addrZeroPageX() {
        return (this.read(this.PC++) + this.X) & 0xff;
    }

    addrZeroPageY() {
        return (this.read(this.PC++) + this.Y) & 0xff;
    }

    addrAbsolute() {
        const lo = this.read(this.PC++);
        const hi = this.read(this.PC++);
        return (hi << 8) | lo;
    }

    addrAbsoluteX() {
        const lo = this.read(this.PC++);
        const hi = this.read(this.PC++);
        const addr = ((hi << 8) | lo) + this.X;
        if ((addr & 0xff00) !== (hi << 8)) {
            this.cycles++; // Page boundary crossing
        }
        this.cycles += 4;
        return addr & 0xffff;
    }

    addrAbsoluteXStore() {
        const lo = this.read(this.PC++);
        const hi = this.read(this.PC++);
        return (((hi << 8) | lo) + this.X) & 0xffff;
    }

    addrAbsoluteY() {
        const lo = this.read(this.PC++);
        const hi = this.read(this.PC++);
        const addr = ((hi << 8) | lo) + this.Y;
        if ((addr & 0xff00) !== (hi << 8)) {
            this.cycles++; // Page boundary crossing
        }
        this.cycles += 4;
        return addr & 0xffff;
    }

    addrAbsoluteYStore() {
        const lo = this.read(this.PC++);
        const hi = this.read(this.PC++);
        return (((hi << 8) | lo) + this.Y) & 0xffff;
    }

    addrIndirectX() {
        const ptr = (this.read(this.PC++) + this.X) & 0xff;
        const lo = this.read(ptr);
        const hi = this.read((ptr + 1) & 0xff);
        return (hi << 8) | lo;
    }

    addrIndirectY() {
        const ptr = this.read(this.PC++);
        const lo = this.read(ptr);
        const hi = this.read((ptr + 1) & 0xff);
        const addr = ((hi << 8) | lo) + this.Y;
        if ((addr & 0xff00) !== (hi << 8)) {
            this.cycles++; // Page boundary crossing
        }
        this.cycles += 5;
        return addr & 0xffff;
    }

    addrIndirectYStore() {
        const ptr = this.read(this.PC++);
        const lo = this.read(ptr);
        const hi = this.read((ptr + 1) & 0xff);
        return (((hi << 8) | lo) + this.Y) & 0xffff;
    }

    // Instructions

    brk() {
        this.PC++;
        this.push((this.PC >> 8) & 0xff);
        this.push(this.PC & 0xff);
        this.push(this.P | FLAG_B | 0x20);
        this.P |= FLAG_I;
        this.PC = this.read(0xfffe) | (this.read(0xffff) << 8);
        this.cycles += 7;
    }

    jsr() {
        const lo = this.read(this.PC++);
        const hi = this.read(this.PC++);
        this.push(((this.PC - 1) >> 8) & 0xff);
        this.push((this.PC - 1) & 0xff);
        this.PC = (hi << 8) | lo;
        this.cycles += 6;
    }

    rts() {
        const lo = this.pop();
        const hi = this.pop();
        this.PC = ((hi << 8) | lo) + 1;
        this.cycles += 6;
    }

    rti() {
        this.P = (this.pop() | 0x20) & ~FLAG_B;
        const lo = this.pop();
        const hi = this.pop();
        this.PC = (hi << 8) | lo;
        this.cycles += 6;
    }

    jmpIndirect() {
        const ptrLo = this.read(this.PC++);
        const ptrHi = this.read(this.PC++);
        const ptr = (ptrHi << 8) | ptrLo;
        // 6502 bug: wrap within page
        const lo = this.read(ptr);
        const hi = this.read((ptrHi << 8) | ((ptrLo + 1) & 0xff));
        this.PC = (hi << 8) | lo;
        this.cycles += 5;
    }

    php() {
        this.push(this.P | FLAG_B | 0x20);
        this.cycles += 3;
    }

    plp() {
        this.P = (this.pop() | 0x20) & ~FLAG_B;
        this.cycles += 4;
    }

    branch(condition) {
        const offset = this.read(this.PC++);
        if (condition) {
            const oldPC = this.PC;
            this.PC = (this.PC + (offset < 128 ? offset : offset - 256)) & 0xffff;
            this.cycles++;
            if ((oldPC & 0xff00) !== (this.PC & 0xff00)) {
                this.cycles++; // Page crossing
            }
        }
        this.cycles += 2;
    }

    // ALU operations

    ora(addr) {
        this.A = this.setNZ(this.A | this.read(addr));
    }

    and(addr) {
        this.A = this.setNZ(this.A & this.read(addr));
    }

    eor(addr) {
        this.A = this.setNZ(this.A ^ this.read(addr));
    }

    bit(addr) {
        const value = this.read(addr);
        this.P &= ~(FLAG_N | FLAG_V | FLAG_Z);
        if (value & 0x80) this.P |= FLAG_N;
        if (value & 0x40) this.P |= FLAG_V;
        if ((this.A & value) === 0) this.P |= FLAG_Z;
        this.cycles += 3;
    }

    adc(addr) {
        const value = this.read(addr);
        const carry = (this.P & FLAG_C) ? 1 : 0;

        if (this.P & FLAG_D) {
            // Decimal mode
            let lo = (this.A & 0x0f) + (value & 0x0f) + carry;
            let hi = (this.A >> 4) + (value >> 4);
            if (lo > 9) { lo -= 10; hi++; }
            if (hi > 9) { hi -= 10; this.P |= FLAG_C; } else { this.P &= ~FLAG_C; }
            // Fix: Do not update N, V, Z flags in decimal mode (NMOS 6502 behavior)
            this.A = ((hi << 4) | (lo & 0x0f)) & 0xff;
        } else {
            const result = this.A + value + carry;
            this.P &= ~(FLAG_C | FLAG_V);
            if (result > 0xff) this.P |= FLAG_C;
            if (~(this.A ^ value) & (this.A ^ result) & 0x80) this.P |= FLAG_V;
            this.A = this.setNZ(result & 0xff);
        }
    }

    sbc(addr) {
        const value = this.read(addr);
        const carry = (this.P & FLAG_C) ? 0 : 1;

        if (this.P & FLAG_D) {
            // Decimal mode
            let lo = (this.A & 0x0f) - (value & 0x0f) - carry;
            let hi = (this.A >> 4) - (value >> 4);
            if (lo < 0) { lo += 10; hi--; }
            if (hi < 0) { hi += 10; this.P &= ~FLAG_C; } else { this.P |= FLAG_C; }
            // Fix: Do not update N, V, Z flags in decimal mode (NMOS 6502 behavior)
            this.A = ((hi << 4) | (lo & 0x0f)) & 0xff;
        } else {
            const result = this.A - value - carry;
            this.P &= ~(FLAG_C | FLAG_V);
            if (result >= 0) this.P |= FLAG_C;
            if ((this.A ^ value) & (this.A ^ result) & 0x80) this.P |= FLAG_V;
            this.A = this.setNZ(result & 0xff);
        }
    }

    cmp(reg, value) {
        const result = reg - value;
        this.P &= ~(FLAG_C | FLAG_N | FLAG_Z);
        if (result >= 0) this.P |= FLAG_C;
        if ((result & 0xff) === 0) this.P |= FLAG_Z;
        if (result & 0x80) this.P |= FLAG_N;
    }

    // Shift/rotate operations

    aslA() {
        this.P &= ~FLAG_C;
        if (this.A & 0x80) this.P |= FLAG_C;
        this.A = this.setNZ((this.A << 1) & 0xff);
        this.cycles += 2;
    }

    aslMem(addr) {
        const original = this.read(addr);
        this.write(addr, original);  // RMW dummy write
        this.P &= ~FLAG_C;
        if (original & 0x80) this.P |= FLAG_C;
        const value = this.setNZ((original << 1) & 0xff);
        this.write(addr, value);
        this.cycles += 5;
    }

    lsrA() {
        this.P &= ~FLAG_C;
        if (this.A & 0x01) this.P |= FLAG_C;
        this.A = this.setNZ(this.A >> 1);
        this.cycles += 2;
    }

    lsrMem(addr) {
        const original = this.read(addr);
        this.write(addr, original);  // RMW dummy write
        this.P &= ~FLAG_C;
        if (original & 0x01) this.P |= FLAG_C;
        const value = this.setNZ(original >> 1);
        this.write(addr, value);
        this.cycles += 5;
    }

    rolA() {
        const carry = (this.P & FLAG_C) ? 1 : 0;
        this.P &= ~FLAG_C;
        if (this.A & 0x80) this.P |= FLAG_C;
        this.A = this.setNZ(((this.A << 1) | carry) & 0xff);
        this.cycles += 2;
    }

    rolMem(addr) {
        const original = this.read(addr);
        this.write(addr, original);  // RMW dummy write
        const carry = (this.P & FLAG_C) ? 1 : 0;
        this.P &= ~FLAG_C;
        if (original & 0x80) this.P |= FLAG_C;
        const value = this.setNZ(((original << 1) | carry) & 0xff);
        this.write(addr, value);
        this.cycles += 5;
    }

    rorA() {
        const carry = (this.P & FLAG_C) ? 0x80 : 0;
        this.P &= ~FLAG_C;
        if (this.A & 0x01) this.P |= FLAG_C;
        this.A = this.setNZ((this.A >> 1) | carry);
        this.cycles += 2;
    }

    rorMem(addr) {
        const original = this.read(addr);
        this.write(addr, original);  // RMW dummy write
        const carry = (this.P & FLAG_C) ? 0x80 : 0;
        this.P &= ~FLAG_C;
        if (original & 0x01) this.P |= FLAG_C;
        const value = this.setNZ((original >> 1) | carry);
        this.write(addr, value);
        this.cycles += 5;
    }

    incMem(addr) {
        const original = this.read(addr);
        this.write(addr, original);  // RMW dummy write (important for VIC-II IRQ ack)
        const value = this.setNZ((original + 1) & 0xff);
        this.write(addr, value);
        this.cycles += 5;
    }

    decMem(addr) {
        const original = this.read(addr);
        this.write(addr, original);  // RMW dummy write (important for VIC-II IRQ ack)
        const value = this.setNZ((original - 1) & 0xff);
        this.write(addr, value);
        this.cycles += 5;
    }

    // Undocumented instructions

    dcp(addr) {
        const original = this.read(addr);
        this.write(addr, original);  // RMW dummy write
        const value = (original - 1) & 0xff;
        this.write(addr, value);
        this.cmp(this.A, value);
    }

    isb(addr) {
        const original = this.read(addr);
        this.write(addr, original);  // RMW dummy write
        const value = (original + 1) & 0xff;
        this.write(addr, value);
        this.sbc(addr);
    }

    slo(addr) {
        const original = this.read(addr);
        this.write(addr, original);  // RMW dummy write
        this.P &= ~FLAG_C;
        if (original & 0x80) this.P |= FLAG_C;
        const value = (original << 1) & 0xff;
        this.write(addr, value);
        this.A = this.setNZ(this.A | value);
    }

    rla(addr) {
        const original = this.read(addr);
        this.write(addr, original);  // RMW dummy write
        const carry = (this.P & FLAG_C) ? 1 : 0;
        this.P &= ~FLAG_C;
        if (original & 0x80) this.P |= FLAG_C;
        const value = ((original << 1) | carry) & 0xff;
        this.write(addr, value);
        this.A = this.setNZ(this.A & value);
    }

    sre(addr) {
        const original = this.read(addr);
        this.write(addr, original);  // RMW dummy write
        this.P &= ~FLAG_C;
        if (original & 0x01) this.P |= FLAG_C;
        const value = original >> 1;
        this.write(addr, value);
        this.A = this.setNZ(this.A ^ value);
    }

    rra(addr) {
        const original = this.read(addr);
        this.write(addr, original);  // RMW dummy write
        const carry = (this.P & FLAG_C) ? 0x80 : 0;
        this.P &= ~FLAG_C;
        if (original & 0x01) this.P |= FLAG_C;
        const value = (original >> 1) | carry;
        this.write(addr, value);
        this.adc(addr);
    }
}
