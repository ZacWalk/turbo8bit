//
// @fileoverview 6502 Assembler for Turbo8bit
// @module emulator/assembler
//
// A simple but educational 6502 assembler that converts assembly source code
// into machine code that can be executed by the C64 emulator.
//
// Features:
// - All official 6502 opcodes
// - Common addressing modes (immediate, zero page, absolute, indexed, indirect)
// - Labels and symbol resolution
// - ORG directive for setting load address
// - BYTE/WORD directives for data
// - Detailed error messages for learning
//
// Usage:
//   import { Assembler } from './assembler.js';
//   const asm = new Assembler();
//   const result = asm.assemble(sourceCode);
//   if (result.success) {
//     machine.loadCode(result.bytes, result.startAddress);
//   }
//
// @see https://www.turbo8bit.com/
//

// ============================================================================
// OPCODE TABLES
// ============================================================================

//
// Addressing mode constants
//
const MODE = {
    IMP: 'implied',      // No operand (e.g., RTS)
    ACC: 'accumulator',  // Operates on A (e.g., ASL A)
    IMM: 'immediate',    // #$nn
    ZP: 'zeropage',     // $nn
    ZPX: 'zeropage,x',   // $nn,X
    ZPY: 'zeropage,y',   // $nn,Y
    ABS: 'absolute',     // $nnnn
    ABX: 'absolute,x',   // $nnnn,X
    ABY: 'absolute,y',   // $nnnn,Y
    IND: 'indirect',     // ($nnnn)
    IZX: 'indirect,x',   // ($nn,X)
    IZY: 'indirect,y',   // ($nn),Y
    REL: 'relative'      // Branch offset
};

//
// Complete 6502 instruction set with opcodes for each addressing mode
// Format: { mnemonic: { mode: opcode, ... } }
//
const OPCODES = {
    // Load/Store
    LDA: { [MODE.IMM]: 0xA9, [MODE.ZP]: 0xA5, [MODE.ZPX]: 0xB5, [MODE.ABS]: 0xAD, [MODE.ABX]: 0xBD, [MODE.ABY]: 0xB9, [MODE.IZX]: 0xA1, [MODE.IZY]: 0xB1 },
    LDX: { [MODE.IMM]: 0xA2, [MODE.ZP]: 0xA6, [MODE.ZPY]: 0xB6, [MODE.ABS]: 0xAE, [MODE.ABY]: 0xBE },
    LDY: { [MODE.IMM]: 0xA0, [MODE.ZP]: 0xA4, [MODE.ZPX]: 0xB4, [MODE.ABS]: 0xAC, [MODE.ABX]: 0xBC },
    STA: { [MODE.ZP]: 0x85, [MODE.ZPX]: 0x95, [MODE.ABS]: 0x8D, [MODE.ABX]: 0x9D, [MODE.ABY]: 0x99, [MODE.IZX]: 0x81, [MODE.IZY]: 0x91 },
    STX: { [MODE.ZP]: 0x86, [MODE.ZPY]: 0x96, [MODE.ABS]: 0x8E },
    STY: { [MODE.ZP]: 0x84, [MODE.ZPX]: 0x94, [MODE.ABS]: 0x8C },

    // Transfer
    TAX: { [MODE.IMP]: 0xAA },
    TAY: { [MODE.IMP]: 0xA8 },
    TXA: { [MODE.IMP]: 0x8A },
    TYA: { [MODE.IMP]: 0x98 },
    TSX: { [MODE.IMP]: 0xBA },
    TXS: { [MODE.IMP]: 0x9A },

    // Stack
    PHA: { [MODE.IMP]: 0x48 },
    PHP: { [MODE.IMP]: 0x08 },
    PLA: { [MODE.IMP]: 0x68 },
    PLP: { [MODE.IMP]: 0x28 },

    // Arithmetic
    ADC: { [MODE.IMM]: 0x69, [MODE.ZP]: 0x65, [MODE.ZPX]: 0x75, [MODE.ABS]: 0x6D, [MODE.ABX]: 0x7D, [MODE.ABY]: 0x79, [MODE.IZX]: 0x61, [MODE.IZY]: 0x71 },
    SBC: { [MODE.IMM]: 0xE9, [MODE.ZP]: 0xE5, [MODE.ZPX]: 0xF5, [MODE.ABS]: 0xED, [MODE.ABX]: 0xFD, [MODE.ABY]: 0xF9, [MODE.IZX]: 0xE1, [MODE.IZY]: 0xF1 },

    // Compare
    CMP: { [MODE.IMM]: 0xC9, [MODE.ZP]: 0xC5, [MODE.ZPX]: 0xD5, [MODE.ABS]: 0xCD, [MODE.ABX]: 0xDD, [MODE.ABY]: 0xD9, [MODE.IZX]: 0xC1, [MODE.IZY]: 0xD1 },
    CPX: { [MODE.IMM]: 0xE0, [MODE.ZP]: 0xE4, [MODE.ABS]: 0xEC },
    CPY: { [MODE.IMM]: 0xC0, [MODE.ZP]: 0xC4, [MODE.ABS]: 0xCC },

    // Logical
    AND: { [MODE.IMM]: 0x29, [MODE.ZP]: 0x25, [MODE.ZPX]: 0x35, [MODE.ABS]: 0x2D, [MODE.ABX]: 0x3D, [MODE.ABY]: 0x39, [MODE.IZX]: 0x21, [MODE.IZY]: 0x31 },
    ORA: { [MODE.IMM]: 0x09, [MODE.ZP]: 0x05, [MODE.ZPX]: 0x15, [MODE.ABS]: 0x0D, [MODE.ABX]: 0x1D, [MODE.ABY]: 0x19, [MODE.IZX]: 0x01, [MODE.IZY]: 0x11 },
    EOR: { [MODE.IMM]: 0x49, [MODE.ZP]: 0x45, [MODE.ZPX]: 0x55, [MODE.ABS]: 0x4D, [MODE.ABX]: 0x5D, [MODE.ABY]: 0x59, [MODE.IZX]: 0x41, [MODE.IZY]: 0x51 },
    BIT: { [MODE.ZP]: 0x24, [MODE.ABS]: 0x2C },

    // Shift/Rotate
    ASL: { [MODE.ACC]: 0x0A, [MODE.ZP]: 0x06, [MODE.ZPX]: 0x16, [MODE.ABS]: 0x0E, [MODE.ABX]: 0x1E },
    LSR: { [MODE.ACC]: 0x4A, [MODE.ZP]: 0x46, [MODE.ZPX]: 0x56, [MODE.ABS]: 0x4E, [MODE.ABX]: 0x5E },
    ROL: { [MODE.ACC]: 0x2A, [MODE.ZP]: 0x26, [MODE.ZPX]: 0x36, [MODE.ABS]: 0x2E, [MODE.ABX]: 0x3E },
    ROR: { [MODE.ACC]: 0x6A, [MODE.ZP]: 0x66, [MODE.ZPX]: 0x76, [MODE.ABS]: 0x6E, [MODE.ABX]: 0x7E },

    // Increment/Decrement
    INC: { [MODE.ZP]: 0xE6, [MODE.ZPX]: 0xF6, [MODE.ABS]: 0xEE, [MODE.ABX]: 0xFE },
    DEC: { [MODE.ZP]: 0xC6, [MODE.ZPX]: 0xD6, [MODE.ABS]: 0xCE, [MODE.ABX]: 0xDE },
    INX: { [MODE.IMP]: 0xE8 },
    INY: { [MODE.IMP]: 0xC8 },
    DEX: { [MODE.IMP]: 0xCA },
    DEY: { [MODE.IMP]: 0x88 },

    // Branch
    BPL: { [MODE.REL]: 0x10 },
    BMI: { [MODE.REL]: 0x30 },
    BVC: { [MODE.REL]: 0x50 },
    BVS: { [MODE.REL]: 0x70 },
    BCC: { [MODE.REL]: 0x90 },
    BCS: { [MODE.REL]: 0xB0 },
    BNE: { [MODE.REL]: 0xD0 },
    BEQ: { [MODE.REL]: 0xF0 },

    // Jump/Call
    JMP: { [MODE.ABS]: 0x4C, [MODE.IND]: 0x6C },
    JSR: { [MODE.ABS]: 0x20 },
    RTS: { [MODE.IMP]: 0x60 },
    RTI: { [MODE.IMP]: 0x40 },

    // Flags
    CLC: { [MODE.IMP]: 0x18 },
    SEC: { [MODE.IMP]: 0x38 },
    CLI: { [MODE.IMP]: 0x58 },
    SEI: { [MODE.IMP]: 0x78 },
    CLV: { [MODE.IMP]: 0xB8 },
    CLD: { [MODE.IMP]: 0xD8 },
    SED: { [MODE.IMP]: 0xF8 },

    // Other
    BRK: { [MODE.IMP]: 0x00 },
    NOP: { [MODE.IMP]: 0xEA }
};

//
// Get instruction size in bytes based on addressing mode
//
function getInstructionSize(mode) {
    switch (mode) {
        case MODE.IMP:
        case MODE.ACC:
            return 1;
        case MODE.IMM:
        case MODE.ZP:
        case MODE.ZPX:
        case MODE.ZPY:
        case MODE.IZX:
        case MODE.IZY:
        case MODE.REL:
            return 2;
        case MODE.ABS:
        case MODE.ABX:
        case MODE.ABY:
        case MODE.IND:
            return 3;
        default:
            return 1;
    }
}

// ============================================================================
// ASSEMBLER
// ============================================================================

//
// 6502 Assembler
//
// Converts assembly source code into machine code bytes.
//
export class Assembler {
    constructor() {
        this.symbols = new Map();
        this.errors = [];
        this.warnings = [];
        this.currentAddress = 0x0800;  // Default start address (BASIC area)
        this.output = [];
        this.sourceMap = [];  // Maps output bytes to source lines
        this.files = new Map(); // Virtual file system for INCBIN
    }

    //
    // Set virtual files for INCBIN
    // @param {Object} files - Map of filename to Uint8Array or Array of bytes
    //
    setFiles(files) {
        for (const [name, data] of Object.entries(files)) {
            this.files.set(name, data);
        }
    }

    //
    // Assemble source code into machine code
    // @param {string} source - Assembly source code
    // @returns {Object} Assembly result with bytes, errors, and metadata
    //
    assemble(source) {
        this.symbols = new Map();
        this.errors = [];
        this.warnings = [];
        this.output = [];
        this.sourceMap = [];
        // Pass-1 mode cache: lineNum -> addressing mode. Pass-2 reuses these so
        // a forward-referenced label that turns out to be zero-page can't shrink
        // an instruction pass-1 sized as absolute (which would mis-align addresses).
        this.lineModes = new Map();

        // Parse into lines
        const lines = source.split('\n').map((line, index) => ({
            text: line,
            lineNum: index + 1,
            trimmed: line.replace(/;.*$/, '').trim()  // Remove comments
        }));

        // Two-pass assembly
        // Pass 1: Calculate addresses and collect symbols
        this.pass1(lines);

        if (this.errors.length > 0) {
            return this.getResult();
        }

        // Pass 2: Generate code with resolved symbols
        this.pass2(lines);

        return this.getResult();
    }

    //
    // Pass 1: Calculate addresses and collect symbols
    //
    pass1(lines) {
        this.currentAddress = 0x0800;

        // Pre-pass: Collect all EQU definitions first
        // This allows forward references to EQU symbols in instruction operands
        // to be resolved correctly when calculating instruction sizes
        for (const line of lines) {
            if (!line.trimmed) continue;
            try {
                const parsed = this.parseLine(line.trimmed, line.lineNum);
                if (parsed.directive === 'EQU') {
                    this.handleDirectivePass1(parsed, line.lineNum);
                }
            } catch (e) {
                // Ignore errors in pre-pass, they'll be caught in main pass
            }
        }

        // Main pass: Process all lines
        for (const line of lines) {
            if (!line.trimmed) continue;

            try {
                const parsed = this.parseLine(line.trimmed, line.lineNum);

                // Handle label (but not for EQU - that handles its own label)
                if (parsed.label && parsed.directive !== 'EQU') {
                    if (this.symbols.has(parsed.label)) {
                        this.error(line.lineNum, `Duplicate label: ${parsed.label}`);
                    } else {
                        this.symbols.set(parsed.label, this.currentAddress);
                    }
                }

                // Handle directives (skip EQU, already processed in pre-pass)
                if (parsed.directive) {
                    if (parsed.directive !== 'EQU') {
                        this.handleDirectivePass1(parsed, line.lineNum);
                    }
                    continue;
                }

                // Handle instruction
                if (parsed.mnemonic) {
                    this.lineModes.set(line.lineNum, parsed.mode);
                    const size = this.getInstructionSize(parsed);
                    this.currentAddress += size;
                }
            } catch (e) {
                this.error(line.lineNum, e.message);
            }
        }
    }

    //
    // Pass 2: Generate machine code
    //
    pass2(lines) {
        this.currentAddress = 0x0800;
        this.output = [];
        this.sourceMap = [];
        let startAddress = null;
        // Track the expected next address for padding calculation
        // This is startAddress + output.length
        this.outputNextAddress = null;

        for (const line of lines) {
            if (!line.trimmed) continue;

            try {
                const parsed = this.parseLine(line.trimmed, line.lineNum);

                // Handle directives
                if (parsed.directive) {
                    if (startAddress === null && parsed.directive !== 'ORG') {
                        startAddress = this.currentAddress;
                        this.outputNextAddress = this.currentAddress;
                    }
                    this.handleDirectivePass2(parsed, line.lineNum);
                    continue;
                }

                // Handle instruction
                if (parsed.mnemonic) {
                    if (startAddress === null) {
                        startAddress = this.currentAddress;
                        this.outputNextAddress = this.currentAddress;
                    }
                    // Force the same addressing mode chosen in pass 1 so byte counts match.
                    if (this.lineModes.has(line.lineNum)) {
                        parsed.mode = this.lineModes.get(line.lineNum);
                    }
                    this.emitInstruction(parsed, line.lineNum);
                }
            } catch (e) {
                this.error(line.lineNum, e.message);
            }
        }

        // Set start address
        this.startAddress = startAddress || 0x0800;
    }

    //
    // Parse a single line of assembly
    //
    parseLine(text, lineNum) {
        const result = {
            label: null,
            mnemonic: null,
            directive: null,
            operand: null,
            mode: null
        };

        // Check for equate syntax: SYMBOL = VALUE
        const equateMatch = text.match(/^(\w+)\s*=\s*(.+)$/);
        if (equateMatch) {
            result.directive = 'EQU';
            result.label = equateMatch[1].toUpperCase();
            result.operand = equateMatch[2].trim();
            return result;
        }

        // Check for label (ends with : or starts at column 0 with no whitespace before instruction)
        let remaining = text;
        const labelMatch = remaining.match(/^(\w+):/);
        if (labelMatch) {
            result.label = labelMatch[1].toUpperCase();
            remaining = remaining.substring(labelMatch[0].length).trim();
        }

        if (!remaining) return result;

        // Parse instruction or directive
        const parts = remaining.split(/\s+/);
        const first = parts[0].toUpperCase();

        // Check for directive
        if (first.startsWith('.') || ['ORG', 'BYTE', 'WORD', 'TEXT', 'DB', 'DW', 'EQU', 'INCBIN'].includes(first)) {
            result.directive = first.replace('.', '');
            result.operand = parts.slice(1).join(' ');
            return result;
        }

        // Must be an instruction
        if (!OPCODES[first]) {
            throw new Error(`Unknown instruction: ${first}`);
        }

        result.mnemonic = first;
        result.operand = parts.slice(1).join(' ').trim();
        result.mode = this.parseAddressingMode(result.operand, first);

        return result;
    }

    //
    // Parse addressing mode from operand
    //
    parseAddressingMode(operand, mnemonic) {
        if (!operand || operand === '' || operand.toUpperCase() === 'A') {
            // Implied or Accumulator
            if (OPCODES[mnemonic][MODE.ACC]) {
                return MODE.ACC;
            }
            return MODE.IMP;
        }

        const op = operand.toUpperCase();

        // Immediate: #$nn or #nn
        if (op.startsWith('#')) {
            return MODE.IMM;
        }

        // Indirect X: ($nn,X)
        if (op.match(/^\(\$?[\dA-F]+\s*,\s*X\s*\)$/i) || op.match(/^\(\w+\s*,\s*X\s*\)$/i)) {
            return MODE.IZX;
        }

        // Indirect Y: ($nn),Y
        if (op.match(/^\(\$?[\dA-F]+\s*\)\s*,\s*Y$/i) || op.match(/^\(\w+\s*\)\s*,\s*Y$/i)) {
            return MODE.IZY;
        }

        // Indirect: ($nnnn)
        if (op.match(/^\(\$?[\dA-F]+\s*\)$/i) || op.match(/^\(\w+\s*\)$/i)) {
            return MODE.IND;
        }

        // Indexed X: $nnnn,X or $nn,X
        if (op.match(/,\s*X$/i)) {
            const value = this.parseValue(op.replace(/,\s*X$/i, ''));
            if (value !== null && value <= 0xFF && OPCODES[mnemonic][MODE.ZPX]) {
                return MODE.ZPX;
            }
            return MODE.ABX;
        }

        // Indexed Y: $nnnn,Y or $nn,Y
        if (op.match(/,\s*Y$/i)) {
            const value = this.parseValue(op.replace(/,\s*Y$/i, ''));
            if (value !== null && value <= 0xFF && OPCODES[mnemonic][MODE.ZPY]) {
                return MODE.ZPY;
            }
            return MODE.ABY;
        }

        // Relative (branches)
        if (OPCODES[mnemonic] && OPCODES[mnemonic][MODE.REL]) {
            return MODE.REL;
        }

        // Zero page or Absolute
        const value = this.parseValue(op);
        if (value !== null && value <= 0xFF && OPCODES[mnemonic][MODE.ZP]) {
            return MODE.ZP;
        }

        return MODE.ABS;
    }

    //
    // Parse a numeric value, symbol, or expression
    // Supports: SYMBOL, SYMBOL+n, SYMBOL-n, <SYMBOL, >SYMBOL
    //
    parseValue(str) {
        if (!str) return null;
        str = str.trim();

        // Low byte operator: <SYMBOL or <$nnnn or <(expr)
        if (str.startsWith('<')) {
            const innerValue = this.parseValue(str.substring(1));
            if (innerValue === null) return null;
            return innerValue & 0xFF;
        }

        // High byte operator: >SYMBOL or >$nnnn or >(expr)
        if (str.startsWith('>')) {
            const innerValue = this.parseValue(str.substring(1));
            if (innerValue === null) return null;
            return (innerValue >> 8) & 0xFF;
        }

        // Check for addition/subtraction expression: SYMBOL+n or SYMBOL-n
        // Handle this BEFORE checking for symbol so we can parse complex expressions
        const addMatch = str.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\+\s*(.+)$/);
        if (addMatch) {
            const baseValue = this.parseValue(addMatch[1]);
            const offsetValue = this.parseValue(addMatch[2]);
            if (baseValue === null || offsetValue === null) return null;
            return (baseValue + offsetValue) & 0xFFFF;
        }

        const subMatch = str.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*-\s*(.+)$/);
        if (subMatch) {
            const baseValue = this.parseValue(subMatch[1]);
            const offsetValue = this.parseValue(subMatch[2]);
            if (baseValue === null || offsetValue === null) return null;
            return (baseValue - offsetValue) & 0xFFFF;
        }

        // Hex: $nn or 0xnn
        if (str.startsWith('$')) {
            return parseInt(str.substring(1), 16);
        }
        if (str.toLowerCase().startsWith('0x')) {
            return parseInt(str.substring(2), 16);
        }

        // Binary: %nnnnnnnn
        if (str.startsWith('%')) {
            return parseInt(str.substring(1), 2);
        }

        // Decimal
        if (/^\d+$/.test(str)) {
            return parseInt(str, 10);
        }

        // Character: 'A'
        if (str.match(/^'.'$/)) {
            return str.charCodeAt(1);
        }

        // Symbol
        if (this.symbols.has(str.toUpperCase())) {
            return this.symbols.get(str.toUpperCase());
        }

        // Unknown symbol - return null (will be resolved in pass 2)
        return null;
    }

    //
    // Get operand value, resolving symbols
    //
    getOperandValue(operand, lineNum) {
        if (!operand) return 0;

        let op = operand.trim();

        // Remove addressing mode decorations
        op = op.replace(/^#/, '');  // Immediate
        op = op.replace(/^\(/, '').replace(/\).*$/, '');  // Indirect
        op = op.replace(/,\s*[XY]$/i, '');  // Indexed

        const value = this.parseValue(op);
        if (value === null) {
            throw new Error(`Undefined symbol: ${op}`);
        }
        return value;
    }

    //
    // Get instruction size
    //
    getInstructionSize(parsed) {
        if (!parsed.mnemonic) return 0;
        return getInstructionSize(parsed.mode);
    }

    //
    // Handle directive in pass 1
    //
    handleDirectivePass1(parsed, lineNum) {
        switch (parsed.directive) {
            case 'ORG':
                const addr = this.parseValue(parsed.operand);
                if (addr === null) {
                    this.error(lineNum, `Invalid address: ${parsed.operand}`);
                } else {
                    this.currentAddress = addr;
                }
                break;

            case 'EQU':
                // Equate: define a symbol with a constant value
                // The label is in parsed.label, the value is in parsed.operand
                if (!parsed.label) {
                    this.error(lineNum, 'EQU requires a symbol name');
                    break;
                }
                const equValue = this.parseValue(parsed.operand);
                if (equValue === null) {
                    this.error(lineNum, `Invalid value for EQU: ${parsed.operand}`);
                } else {
                    if (this.symbols.has(parsed.label)) {
                        this.error(lineNum, `Duplicate symbol: ${parsed.label}`);
                    } else {
                        this.symbols.set(parsed.label, equValue);
                    }
                }
                break;

            case 'BYTE':
            case 'DB':
                const bytes = this.parseDataBytes(parsed.operand);
                this.currentAddress += bytes.length;
                break;

            case 'WORD':
            case 'DW':
                const words = parsed.operand.split(',');
                this.currentAddress += words.length * 2;
                break;

            case 'TEXT':
                const text = this.parseString(parsed.operand);
                this.currentAddress += text.length;
                break;

            case 'INCBIN':
                const filename = this.parseString(parsed.operand);
                if (this.files.has(filename)) {
                    const data = this.files.get(filename);
                    this.currentAddress += data.length;
                } else {
                    this.error(lineNum, `File not found: ${filename}`);
                }
                break;
        }
    }

    //
    // Handle directive in pass 2
    //
    handleDirectivePass2(parsed, lineNum) {
        switch (parsed.directive) {
            case 'ORG':
                const newAddr = this.parseValue(parsed.operand);
                // If we've already emitted code and new address is higher,
                // pad with zeros to fill the gap
                if (this.outputNextAddress !== null && newAddr > this.outputNextAddress) {
                    const padding = newAddr - this.outputNextAddress;
                    for (let i = 0; i < padding; i++) {
                        this.output.push(0);
                        this.sourceMap.push({
                            address: this.outputNextAddress + i,
                            lineNum: lineNum
                        });
                    }
                    this.outputNextAddress = newAddr;
                } else if (this.outputNextAddress === null) {
                    // First ORG sets the starting point
                    this.outputNextAddress = newAddr;
                }
                this.currentAddress = newAddr;
                break;

            case 'EQU':
                // EQU is fully handled in pass 1, no code generation needed
                break;

            case 'BYTE':
            case 'DB':
                const bytes = this.parseDataBytes(parsed.operand);
                for (const b of bytes) {
                    this.emit(b & 0xFF, lineNum);
                }
                break;

            case 'WORD':
            case 'DW':
                const words = parsed.operand.split(',');
                for (const w of words) {
                    const value = this.parseValue(w.trim());
                    this.emit(value & 0xFF, lineNum);
                    this.emit((value >> 8) & 0xFF, lineNum);
                }
                break;

            case 'INCBIN':
                const filename = this.parseString(parsed.operand);
                if (this.files.has(filename)) {
                    const data = this.files.get(filename);
                    for (let i = 0; i < data.length; i++) {
                        this.emit(data[i], lineNum);
                    }
                }
                // Error already reported in pass 1
                break;

            case 'TEXT':
                const text = this.parseString(parsed.operand);
                for (const ch of text) {
                    this.emit(ch.charCodeAt(0), lineNum);
                }
                break;
        }
    }

    //
    // Parse data bytes (comma-separated values)
    //
    parseDataBytes(operand) {
        const bytes = [];
        const parts = operand.split(',');
        for (const part of parts) {
            const value = this.parseValue(part.trim());
            if (value !== null) {
                bytes.push(value);
            }
        }
        return bytes;
    }

    //
    // Parse a string literal
    //
    parseString(operand) {
        const match = operand.match(/^["'](.*)["']$/);
        if (match) {
            return match[1];
        }
        return operand;
    }

    /**
    * Emit an instruction
    */
    emitInstruction(parsed, lineNum) {
        const opcode = OPCODES[parsed.mnemonic][parsed.mode];
        if (opcode === undefined) {
            throw new Error(`Invalid addressing mode ${parsed.mode} for ${parsed.mnemonic}`);
        }

        this.emit(opcode, lineNum);

        const size = getInstructionSize(parsed.mode);

        if (size > 1) {
            let value = this.getOperandValue(parsed.operand, lineNum);

            // Handle relative addressing (branches)
            if (parsed.mode === MODE.REL) {
                const offset = value - (this.currentAddress + 1);
                if (offset < -128 || offset > 127) {
                    this.error(lineNum, `Branch target out of range: ${offset}`);
                    value = 0;
                } else {
                    value = offset & 0xFF;
                }
                this.emit(value, lineNum);
            } else if (size === 2) {
                this.emit(value & 0xFF, lineNum);
            } else {
                this.emit(value & 0xFF, lineNum);
                this.emit((value >> 8) & 0xFF, lineNum);
            }
        }
    }

    /**
    * Emit a byte
    */
    emit(byte, lineNum) {
        this.output.push(byte & 0xFF);
        this.sourceMap.push({
            address: this.currentAddress,
            lineNum: lineNum
        });
        this.currentAddress++;
        // Keep outputNextAddress in sync
        if (this.outputNextAddress !== null) {
            this.outputNextAddress++;
        }
    }

    /**
    * Add error
    */
    error(lineNum, message) {
        this.errors.push({ lineNum, message });
    }

    /**
    * Add warning
    */
    warning(lineNum, message) {
        this.warnings.push({ lineNum, message });
    }

    /**
    * Get assembly result
    */
    getResult() {
        return {
            success: this.errors.length === 0,
            bytes: new Uint8Array(this.output),
            startAddress: this.startAddress || 0x0800,
            symbols: Object.fromEntries(this.symbols),
            sourceMap: this.sourceMap,
            errors: this.errors,
            warnings: this.warnings
        };
    }
}

/**
* Disassemble a single instruction
* @param {Uint8Array} memory - Memory buffer
* @param {number} address - Address to disassemble
* @returns {Object} Disassembly result
*/
export function disassembleInstruction(memory, address) {
    const opcode = memory[address];

    // Find the mnemonic and mode for this opcode
    for (const [mnemonic, modes] of Object.entries(OPCODES)) {
        for (const [mode, code] of Object.entries(modes)) {
            if (code === opcode) {
                const size = getInstructionSize(mode);
                let operand = '';
                let bytes = [opcode];

                if (size === 2) {
                    const value = memory[address + 1];
                    bytes.push(value);
                    operand = formatOperand(mode, value, address + 2);
                } else if (size === 3) {
                    const lo = memory[address + 1];
                    const hi = memory[address + 2];
                    bytes.push(lo, hi);
                    operand = formatOperand(mode, lo | (hi << 8), address + 3);
                }

                return {
                    address,
                    bytes,
                    size,
                    mnemonic,
                    mode,
                    operand,
                    text: `${mnemonic} ${operand}`.trim()
                };
            }
        }
    }

    // Unknown opcode
    return {
        address,
        bytes: [opcode],
        size: 1,
        mnemonic: '???',
        mode: MODE.IMP,
        operand: '',
        text: `??? ($${opcode.toString(16).padStart(2, '0').toUpperCase()})`
    };
}

/**
* Format operand for display
*/
function formatOperand(mode, value, nextAddress) {
    switch (mode) {
        case MODE.IMP:
        case MODE.ACC:
            return mode === MODE.ACC ? 'A' : '';
        case MODE.IMM:
            return `#$${value.toString(16).padStart(2, '0').toUpperCase()}`;
        case MODE.ZP:
            return `$${value.toString(16).padStart(2, '0').toUpperCase()}`;
        case MODE.ZPX:
            return `$${value.toString(16).padStart(2, '0').toUpperCase()},X`;
        case MODE.ZPY:
            return `$${value.toString(16).padStart(2, '0').toUpperCase()},Y`;
        case MODE.ABS:
            return `$${value.toString(16).padStart(4, '0').toUpperCase()}`;
        case MODE.ABX:
            return `$${value.toString(16).padStart(4, '0').toUpperCase()},X`;
        case MODE.ABY:
            return `$${value.toString(16).padStart(4, '0').toUpperCase()},Y`;
        case MODE.IND:
            return `($${value.toString(16).padStart(4, '0').toUpperCase()})`;
        case MODE.IZX:
            return `($${value.toString(16).padStart(2, '0').toUpperCase()},X)`;
        case MODE.IZY:
            return `($${value.toString(16).padStart(2, '0').toUpperCase()}),Y`;
        case MODE.REL:
            const target = nextAddress + (value > 127 ? value - 256 : value);
            return `$${target.toString(16).padStart(4, '0').toUpperCase()}`;
        default:
            return `$${value.toString(16).toUpperCase()}`;
    }
}

/**
* Disassemble a range of memory
* @param {Uint8Array} memory - Memory buffer
* @param {number} start - Start address
* @param {number} length - Number of bytes to disassemble
* @returns {Array} Array of disassembly results
*/
export function disassemble(memory, start, length) {
    const instructions = [];
    let address = start;
    const end = start + length;

    while (address < end) {
        const instr = disassembleInstruction(memory, address);
        instructions.push(instr);
        address += instr.size;
    }

    return instructions;
}

// Export for browser usage
if (typeof window !== 'undefined') {
    window.Assembler = Assembler;
    window.disassembleInstruction = disassembleInstruction;
    window.disassemble = disassemble;
}
