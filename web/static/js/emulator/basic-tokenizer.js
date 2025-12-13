//
// @fileoverview BASIC Tokenizer - Converts BASIC text to C64 memory format
// @module emulator/basic-tokenizer
//
// This module provides tokenization of Commodore BASIC V2 programs:
// - Converts BASIC text to tokenized memory format
// - Handles all BASIC keywords and their tokens
// - Supports line numbers and program structure
// - Provides syntax validation
//
// C64 BASIC Program Memory Layout:
//   - Programs start at $0801 (2049)
//   - Each line: [next-addr-lo] [next-addr-hi] [line-num-lo] [line-num-hi] [tokens...] [0x00]
//   - Program ends with [0x00] [0x00]
//
// @see https://www.turbo8bit.com/
//

// ============================================================================
// BASIC TOKENS
// ============================================================================

// BASIC V2 keyword tokens (0x80-0xCB)
// The token value is 0x80 + index in this array
export const BASIC_KEYWORDS = [
    'END',      // $80
    'FOR',      // $81
    'NEXT',     // $82
    'DATA',     // $83
    'INPUT#',   // $84
    'INPUT',    // $85
    'DIM',      // $86
    'READ',     // $87
    'LET',      // $88
    'GOTO',     // $89
    'RUN',      // $8A
    'IF',       // $8B
    'RESTORE',  // $8C
    'GOSUB',    // $8D
    'RETURN',   // $8E
    'REM',      // $8F
    'STOP',     // $90
    'ON',       // $91
    'WAIT',     // $92
    'LOAD',     // $93
    'SAVE',     // $94
    'VERIFY',   // $95
    'DEF',      // $96
    'POKE',     // $97
    'PRINT#',   // $98
    'PRINT',    // $99
    'CONT',     // $9A
    'LIST',     // $9B
    'CLR',      // $9C
    'CMD',      // $9D
    'SYS',      // $9E
    'OPEN',     // $9F
    'CLOSE',    // $A0
    'GET',      // $A1
    'NEW',      // $A2
    'TAB(',     // $A3
    'TO',       // $A4
    'FN',       // $A5
    'SPC(',     // $A6
    'THEN',     // $A7
    'NOT',      // $A8
    'STEP',     // $A9
    '+',        // $AA
    '-',        // $AB
    '*',        // $AC
    '/',        // $AD
    '^',        // $AE (power/exponent - NOT the up-arrow character)
    'AND',      // $AF
    'OR',       // $B0
    '>',        // $B1
    '=',        // $B2
    '<',        // $B3
    'SGN',      // $B4
    'INT',      // $B5
    'ABS',      // $B6
    'USR',      // $B7
    'FRE',      // $B8
    'POS',      // $B9
    'SQR',      // $BA
    'RND',      // $BB
    'LOG',      // $BC
    'EXP',      // $BD
    'COS',      // $BE
    'SIN',      // $BF
    'TAN',      // $C0
    'ATN',      // $C1
    'PEEK',     // $C2
    'LEN',      // $C3
    'STR$',     // $C4
    'VAL',      // $C5
    'ASC',      // $C6
    'CHR$',     // $C7
    'LEFT$',    // $C8
    'RIGHT$',   // $C9
    'MID$',     // $CA
    'GO',       // $CB (for GO TO)
];

// Create a lookup map for faster keyword matching
const KEYWORD_MAP = new Map();
BASIC_KEYWORDS.forEach((keyword, index) => {
    KEYWORD_MAP.set(keyword, 0x80 + index);
});

// Secondary keyword patterns (must match before shorter ones)
// Sorted by length descending for proper matching
const SORTED_KEYWORDS = [...BASIC_KEYWORDS].sort((a, b) => b.length - a.length);

// BASIC program start address (default: $0801 = 2049)
export const BASIC_START = 0x0801;

// ============================================================================
// TOKENIZER CLASS
// ============================================================================

//
// BASICTokenizer - Converts BASIC text to C64 tokenized format
//
export class BASICTokenizer {
    constructor() {
        this.errors = [];
    }

    //
    // Tokenize a complete BASIC program
    // @param {string} source - The BASIC source code
    // @param {number} startAddress - Memory address to start (default: $0801)
    // @returns {{ bytes: Uint8Array, errors: Array, lines: Array }}
    //
    tokenize(source, startAddress = BASIC_START) {
        this.errors = [];
        const lines = [];
        const sourceLines = source.split('\n');

        // Parse each line
        let lastLineNum = -1;

        for (let i = 0; i < sourceLines.length; i++) {
            const sourceLine = sourceLines[i].trim();
            if (sourceLine === '') continue;

            const parsed = this.parseLine(sourceLine, i + 1);
            if (parsed.error) {
                this.errors.push(parsed.error);
                continue;
            }

            // Check line number order
            if (parsed.lineNum <= lastLineNum) {
                this.errors.push({
                    line: i + 1,
                    column: 1,
                    message: `Line number ${parsed.lineNum} is out of order (previous was ${lastLineNum})`,
                    type: 'error'
                });
            }
            lastLineNum = parsed.lineNum;

            lines.push(parsed);
        }

        // Build the tokenized program
        const bytes = this.buildProgram(lines, startAddress);

        return { bytes, errors: this.errors, lines };
    }

    //
    // Parse a single BASIC line
    // @param {string} line - The source line
    // @param {number} sourceLineNum - Source file line number (for error reporting)
    // @returns {{ lineNum: number, tokens: Uint8Array, error?: Object }}
    //
    parseLine(line, sourceLineNum) {
        // Extract line number
        const lineNumMatch = line.match(/^(\d+)\s*/);
        if (!lineNumMatch) {
            return {
                error: {
                    line: sourceLineNum,
                    column: 1,
                    message: 'Line must start with a line number',
                    type: 'error'
                }
            };
        }

        const lineNum = parseInt(lineNumMatch[1], 10);
        if (lineNum < 0 || lineNum > 63999) {
            return {
                error: {
                    line: sourceLineNum,
                    column: 1,
                    message: `Line number ${lineNum} out of range (0-63999)`,
                    type: 'error'
                }
            };
        }

        const content = line.slice(lineNumMatch[0].length);
        const tokens = this.tokenizeLine(content, sourceLineNum);

        return { lineNum, tokens, sourceLineNum };
    }

    //
    // Tokenize the content of a single line (after the line number)
    // @param {string} content - Line content without line number
    // @param {number} sourceLineNum - Source file line number
    // @returns {Uint8Array} Tokenized bytes
    //
    tokenizeLine(content, sourceLineNum) {
        const tokens = [];
        let i = 0;
        let inString = false;
        let inRem = false;
        let inData = false;

        while (i < content.length) {
            const ch = content[i];

            // Handle strings - don't tokenize inside quotes
            if (ch === '"') {
                inString = !inString;
                tokens.push(ch.charCodeAt(0));
                i++;
                continue;
            }

            if (inString) {
                // Convert to PETSCII (uppercase letters stay the same in C64 mode)
                tokens.push(this.toPetscii(ch));
                i++;
                continue;
            }

            // Inside REM - rest of line is literal text
            if (inRem) {
                tokens.push(this.toPetscii(ch));
                i++;
                continue;
            }

            // Inside DATA - only tokenize commas and colons
            if (inData) {
                if (ch === ':') {
                    inData = false;
                    tokens.push(ch.charCodeAt(0));
                    i++;
                    continue;
                }
                tokens.push(this.toPetscii(ch));
                i++;
                continue;
            }

            // Try to match a keyword
            const remaining = content.slice(i).toUpperCase();
            let matched = false;

            for (const keyword of SORTED_KEYWORDS) {
                if (remaining.startsWith(keyword)) {
                    // Make sure it's not part of a longer identifier
                    const afterKeyword = remaining[keyword.length];
                    const isAlphaNum = afterKeyword && /[A-Z0-9$%]/.test(afterKeyword);

                    // Operators should ALWAYS be tokenized (they're single-char and can be followed by anything)
                    const isOperator = ['+', '-', '*', '/', '^', '>', '=', '<'].includes(keyword);

                    // Special case: some keywords can be followed by alphanumerics
                    // (like GOTO10 or PRINT, but not things like PRINTER)
                    if (isAlphaNum && !isOperator && !['GOTO', 'GOSUB', 'THEN', 'TO', 'STEP', 'ON', 'IF', 'AND', 'OR', 'NOT'].includes(keyword)) {
                        continue;
                    }

                    const token = KEYWORD_MAP.get(keyword);
                    tokens.push(token);
                    i += keyword.length;
                    matched = true;

                    // Track special modes
                    if (keyword === 'REM') {
                        inRem = true;
                    } else if (keyword === 'DATA') {
                        inData = true;
                    }

                    break;
                }
            }

            if (!matched) {
                // Regular character - convert to PETSCII uppercase
                tokens.push(this.toPetscii(ch.toUpperCase()));
                i++;
            }
        }

        return new Uint8Array(tokens);
    }

    //
    // Convert ASCII character to PETSCII
    // @param {string} ch - ASCII character
    // @returns {number} PETSCII code
    //
    toPetscii(ch) {
        const code = ch.charCodeAt(0);

        // ASCII and PETSCII are mostly compatible for printable chars
        // Uppercase letters: A-Z (65-90) are the same
        // Lowercase letters: a-z (97-122) -> uppercase in C64 text mode
        if (code >= 97 && code <= 122) {
            return code - 32; // Convert to uppercase
        }

        // Most other printable ASCII chars are the same
        return code;
    }

    //
    // Build the complete tokenized program
    // @param {Array} lines - Array of parsed lines
    // @param {number} startAddress - Memory start address
    // @returns {Uint8Array} Complete tokenized program with PRG header
    //
    buildProgram(lines, startAddress) {
        const output = [];

        // PRG header (2 bytes: load address)
        output.push(startAddress & 0xFF);
        output.push((startAddress >> 8) & 0xFF);

        let currentAddr = startAddress;

        for (const line of lines) {
            // Calculate next line address
            // Format: next-lo, next-hi, linenum-lo, linenum-hi, tokens..., 0x00
            const lineData = [
                0, 0,  // Placeholder for next line address
                line.lineNum & 0xFF,
                (line.lineNum >> 8) & 0xFF,
                ...line.tokens,
                0x00  // Line terminator
            ];

            const nextAddr = currentAddr + lineData.length;
            lineData[0] = nextAddr & 0xFF;
            lineData[1] = (nextAddr >> 8) & 0xFF;

            output.push(...lineData);
            currentAddr = nextAddr;
        }

        // Program terminator (null next-line pointer)
        output.push(0x00, 0x00);

        return new Uint8Array(output);
    }

    //
    // Validate BASIC source and return syntax errors/warnings
    // @param {string} source - The BASIC source code
    // @returns {Array} Array of error/warning objects
    //
    validate(source) {
        this.errors = [];
        const lines = source.split('\n');
        let lastLineNum = -1;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line === '') continue;

            // Check for line number
            const lineNumMatch = line.match(/^(\d+)\s*/);
            if (!lineNumMatch) {
                this.errors.push({
                    line: i + 1,
                    column: 1,
                    message: 'Line must start with a line number',
                    type: 'error'
                });
                continue;
            }

            const lineNum = parseInt(lineNumMatch[1], 10);

            // Check line number range
            if (lineNum < 0 || lineNum > 63999) {
                this.errors.push({
                    line: i + 1,
                    column: 1,
                    message: `Line number ${lineNum} out of range (0-63999)`,
                    type: 'error'
                });
            }

            // Check line number order
            if (lineNum <= lastLineNum) {
                this.errors.push({
                    line: i + 1,
                    column: 1,
                    message: `Line number ${lineNum} should be greater than ${lastLineNum}`,
                    type: 'warning'
                });
            }
            lastLineNum = lineNum;

            // Check for unmatched quotes
            const content = line.slice(lineNumMatch[0].length);
            let quoteCount = 0;
            for (const ch of content) {
                if (ch === '"') quoteCount++;
            }
            if (quoteCount % 2 !== 0) {
                this.errors.push({
                    line: i + 1,
                    column: line.lastIndexOf('"') + 1,
                    message: 'Unmatched quote',
                    type: 'warning'
                });
            }

            // Check for empty GOTO/GOSUB targets
            const gotoMatch = content.match(/\b(GOTO|GOSUB)\s*$/i);
            if (gotoMatch) {
                this.errors.push({
                    line: i + 1,
                    column: lineNumMatch[0].length + content.indexOf(gotoMatch[1]) + 1,
                    message: `${gotoMatch[1].toUpperCase()} requires a line number`,
                    type: 'error'
                });
            }

            // Check for invalid THEN usage
            const thenMatch = content.match(/\bTHEN\s*$/i);
            if (thenMatch) {
                this.errors.push({
                    line: i + 1,
                    column: lineNumMatch[0].length + content.indexOf('THEN') + 1,
                    message: 'THEN requires a statement or line number',
                    type: 'error'
                });
            }

            // Check for unmatched parentheses
            let parenCount = 0;
            let inString = false;
            for (let j = 0; j < content.length; j++) {
                const ch = content[j];
                if (ch === '"') inString = !inString;
                if (!inString) {
                    if (ch === '(') parenCount++;
                    if (ch === ')') parenCount--;
                }
            }
            if (parenCount !== 0) {
                this.errors.push({
                    line: i + 1,
                    column: lineNumMatch[0].length + 1,
                    message: parenCount > 0 ? 'Unmatched opening parenthesis' : 'Unmatched closing parenthesis',
                    type: 'error'
                });
            }
        }

        return this.errors;
    }
}

// ============================================================================
// SYNTAX HIGHLIGHTING
// ============================================================================

// Token types for syntax highlighting
export const TokenType = {
    KEYWORD: 'keyword',
    STRING: 'string',
    NUMBER: 'number',
    OPERATOR: 'operator',
    COMMENT: 'comment',
    VARIABLE: 'variable',
    FUNCTION: 'function',
    LINENUMBER: 'linenumber',
    PUNCTUATION: 'punctuation',
    ERROR: 'error',
    DEFAULT: 'default',
};

// BASIC functions (subset of keywords that are functions)
const BASIC_FUNCTIONS = new Set([
    'SGN', 'INT', 'ABS', 'USR', 'FRE', 'POS', 'SQR', 'RND', 'LOG', 'EXP',
    'COS', 'SIN', 'TAN', 'ATN', 'PEEK', 'LEN', 'STR$', 'VAL', 'ASC', 'CHR$',
    'LEFT$', 'RIGHT$', 'MID$', 'TAB(', 'SPC(', 'FN'
]);

// BASIC statements (keywords that start statements)
const BASIC_STATEMENTS = new Set([
    'END', 'FOR', 'NEXT', 'DATA', 'INPUT#', 'INPUT', 'DIM', 'READ', 'LET',
    'GOTO', 'RUN', 'IF', 'RESTORE', 'GOSUB', 'RETURN', 'REM', 'STOP', 'ON',
    'WAIT', 'LOAD', 'SAVE', 'VERIFY', 'DEF', 'POKE', 'PRINT#', 'PRINT',
    'CONT', 'LIST', 'CLR', 'CMD', 'SYS', 'OPEN', 'CLOSE', 'GET', 'NEW', 'GO'
]);

// Operators (some are also tokens)
const OPERATORS = new Set(['+', '-', '*', '/', '^', '=', '<', '>', 'AND', 'OR', 'NOT']);

//
// Highlight BASIC source code for display
// @param {string} source - The BASIC source code
// @returns {Array<{text: string, type: string, line: number}>} Highlighted tokens
//
export function highlightBasic(source) {
    const tokens = [];
    const lines = source.split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const lineTokens = highlightLine(line, lineIdx + 1);
        tokens.push(...lineTokens);

        // Add newline token between lines
        if (lineIdx < lines.length - 1) {
            tokens.push({ text: '\n', type: TokenType.DEFAULT, line: lineIdx + 1 });
        }
    }

    return tokens;
}

//
// Highlight a single BASIC line
// @param {string} line - The line to highlight
// @param {number} lineNum - Line number in source
// @returns {Array} Array of token objects
//
function highlightLine(line, lineNum) {
    const tokens = [];
    let i = 0;

    // Skip leading whitespace
    while (i < line.length && /\s/.test(line[i])) {
        tokens.push({ text: line[i], type: TokenType.DEFAULT, line: lineNum });
        i++;
    }

    // Parse line number
    const lineNumMatch = line.slice(i).match(/^(\d+)/);
    if (lineNumMatch) {
        tokens.push({ text: lineNumMatch[1], type: TokenType.LINENUMBER, line: lineNum });
        i += lineNumMatch[1].length;
    }

    // Skip space after line number
    while (i < line.length && line[i] === ' ') {
        tokens.push({ text: ' ', type: TokenType.DEFAULT, line: lineNum });
        i++;
    }

    let inString = false;
    let inRem = false;
    let inData = false;

    while (i < line.length) {
        const ch = line[i];

        // Handle strings
        if (ch === '"') {
            if (!inRem) {
                inString = !inString;
            }
            tokens.push({ text: ch, type: inRem ? TokenType.COMMENT : TokenType.STRING, line: lineNum });
            i++;
            continue;
        }

        if (inString) {
            tokens.push({ text: ch, type: TokenType.STRING, line: lineNum });
            i++;
            continue;
        }

        // Inside REM
        if (inRem) {
            tokens.push({ text: ch, type: TokenType.COMMENT, line: lineNum });
            i++;
            continue;
        }

        // Inside DATA (special handling)
        if (inData) {
            if (ch === ':') {
                inData = false;
                tokens.push({ text: ch, type: TokenType.PUNCTUATION, line: lineNum });
            } else if (/\d/.test(ch)) {
                // Collect number
                let num = '';
                while (i < line.length && /[\d.]/.test(line[i])) {
                    num += line[i];
                    i++;
                }
                tokens.push({ text: num, type: TokenType.NUMBER, line: lineNum });
                continue;
            } else {
                tokens.push({ text: ch, type: TokenType.DEFAULT, line: lineNum });
            }
            i++;
            continue;
        }

        // Try to match a keyword
        const remaining = line.slice(i).toUpperCase();
        let matched = false;

        for (const keyword of SORTED_KEYWORDS) {
            if (remaining.startsWith(keyword)) {
                // Check it's not part of a variable name
                const afterKeyword = remaining[keyword.length];
                const prevChar = i > 0 ? line[i - 1] : '';

                // If previous char is alphanumeric, this is part of a variable
                if (/[A-Z0-9]/.test(prevChar.toUpperCase())) {
                    continue;
                }

                // Some keywords can be followed by alphanumerics (like GOTO10)
                const canFollowAlpha = ['GOTO', 'GOSUB', 'THEN', 'TO', 'STEP', 'ON', 'IF', 'AND', 'OR', 'NOT'].includes(keyword);
                if (!canFollowAlpha && afterKeyword && /[A-Z0-9]/.test(afterKeyword)) {
                    continue;
                }

                // Determine token type
                let type = TokenType.KEYWORD;
                if (BASIC_FUNCTIONS.has(keyword)) {
                    type = TokenType.FUNCTION;
                } else if (OPERATORS.has(keyword)) {
                    type = TokenType.OPERATOR;
                }

                tokens.push({ text: line.slice(i, i + keyword.length), type, line: lineNum });
                i += keyword.length;
                matched = true;

                if (keyword === 'REM') {
                    inRem = true;
                } else if (keyword === 'DATA') {
                    inData = true;
                }

                break;
            }
        }

        if (matched) continue;

        // Numbers
        if (/\d/.test(ch) || (ch === '.' && i + 1 < line.length && /\d/.test(line[i + 1]))) {
            let num = '';
            while (i < line.length && /[\d.E+-]/.test(line[i].toUpperCase())) {
                // Handle scientific notation carefully
                if ((line[i] === '+' || line[i] === '-') &&
                    num.length > 0 &&
                    num[num.length - 1].toUpperCase() !== 'E') {
                    break;
                }
                num += line[i];
                i++;
            }
            tokens.push({ text: num, type: TokenType.NUMBER, line: lineNum });
            continue;
        }

        // Variables (letters followed by alphanumerics, ending with optional $ or %)
        if (/[A-Za-z]/.test(ch)) {
            let variable = '';
            while (i < line.length && /[A-Za-z0-9]/.test(line[i])) {
                variable += line[i];
                i++;
            }
            // Check for type suffix
            if (i < line.length && (line[i] === '$' || line[i] === '%')) {
                variable += line[i];
                i++;
            }
            tokens.push({ text: variable, type: TokenType.VARIABLE, line: lineNum });
            continue;
        }

        // Operators
        if ('+-*/^=<>'.includes(ch)) {
            // Check for compound operators
            if ((ch === '<' || ch === '>') && i + 1 < line.length) {
                const next = line[i + 1];
                if (next === '=' || next === '>' || next === '<') {
                    tokens.push({ text: ch + next, type: TokenType.OPERATOR, line: lineNum });
                    i += 2;
                    continue;
                }
            }
            tokens.push({ text: ch, type: TokenType.OPERATOR, line: lineNum });
            i++;
            continue;
        }

        // Punctuation
        if (':;,()'.includes(ch)) {
            tokens.push({ text: ch, type: TokenType.PUNCTUATION, line: lineNum });
            i++;
            continue;
        }

        // Default (whitespace, unknown)
        tokens.push({ text: ch, type: TokenType.DEFAULT, line: lineNum });
        i++;
    }

    return tokens;
}

// ============================================================================
// 6502 ASSEMBLY HIGHLIGHTING
// ============================================================================

// 6502 instructions
const ASM_INSTRUCTIONS = new Set([
    'ADC', 'AND', 'ASL', 'BCC', 'BCS', 'BEQ', 'BIT', 'BMI', 'BNE', 'BPL',
    'BRK', 'BVC', 'BVS', 'CLC', 'CLD', 'CLI', 'CLV', 'CMP', 'CPX', 'CPY',
    'DEC', 'DEX', 'DEY', 'EOR', 'INC', 'INX', 'INY', 'JMP', 'JSR', 'LDA',
    'LDX', 'LDY', 'LSR', 'NOP', 'ORA', 'PHA', 'PHP', 'PLA', 'PLP', 'ROL',
    'ROR', 'RTI', 'RTS', 'SBC', 'SEC', 'SED', 'SEI', 'STA', 'STX', 'STY',
    'TAX', 'TAY', 'TSX', 'TXA', 'TXS', 'TYA'
]);

// Assembler directives
const ASM_DIRECTIVES = new Set([
    '.ORG', '.BYTE', '.WORD', '.TEXT', '.INCLUDE', '.DEFINE', '.EQU',
    '*=', '.DB', '.DW', '.DS', '.ALIGN', '.MACRO', '.ENDM', '.IF', '.ENDIF',
    '.ELSE', '.PROC', '.ENDP', '.SEGMENT', '.CODE', '.DATA', '.BSS'
]);

//
// Highlight 6502 assembly code
// @param {string} source - The assembly source code
// @returns {Array} Highlighted tokens
//
export function highlightAssembly(source) {
    const tokens = [];
    const lines = source.split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const lineTokens = highlightAsmLine(line, lineIdx + 1);
        tokens.push(...lineTokens);

        if (lineIdx < lines.length - 1) {
            tokens.push({ text: '\n', type: TokenType.DEFAULT, line: lineIdx + 1 });
        }
    }

    return tokens;
}

function highlightAsmLine(line, lineNum) {
    const tokens = [];
    let i = 0;

    // Check for comment (semicolon starts comment in most assemblers)
    const commentIdx = line.indexOf(';');
    const codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
    const commentPart = commentIdx >= 0 ? line.slice(commentIdx) : '';

    // Process label at start of line
    const labelMatch = codePart.match(/^([A-Za-z_][A-Za-z0-9_]*):?\s*/);
    if (labelMatch && labelMatch[1]) {
        tokens.push({ text: labelMatch[0], type: TokenType.VARIABLE, line: lineNum });
        i = labelMatch[0].length;
    }

    // Skip whitespace
    while (i < codePart.length && /\s/.test(codePart[i])) {
        tokens.push({ text: codePart[i], type: TokenType.DEFAULT, line: lineNum });
        i++;
    }

    // Look for instruction or directive
    const remaining = codePart.slice(i);
    const wordMatch = remaining.match(/^([A-Za-z.*=][A-Za-z0-9_]*)/);

    if (wordMatch) {
        const word = wordMatch[1].toUpperCase();
        let type = TokenType.DEFAULT;

        if (ASM_INSTRUCTIONS.has(word)) {
            type = TokenType.KEYWORD;
        } else if (ASM_DIRECTIVES.has(word) || word.startsWith('.') || word.startsWith('*')) {
            type = TokenType.FUNCTION;
        }

        tokens.push({ text: codePart.slice(i, i + wordMatch[1].length), type, line: lineNum });
        i += wordMatch[1].length;
    }

    // Rest of the operand
    while (i < codePart.length) {
        const ch = codePart[i];

        // Hex numbers
        if (ch === '$' && i + 1 < codePart.length && /[0-9A-Fa-f]/.test(codePart[i + 1])) {
            let hex = '$';
            i++;
            while (i < codePart.length && /[0-9A-Fa-f]/.test(codePart[i])) {
                hex += codePart[i];
                i++;
            }
            tokens.push({ text: hex, type: TokenType.NUMBER, line: lineNum });
            continue;
        }

        // Binary numbers
        if (ch === '%' && i + 1 < codePart.length && /[01]/.test(codePart[i + 1])) {
            let bin = '%';
            i++;
            while (i < codePart.length && /[01]/.test(codePart[i])) {
                bin += codePart[i];
                i++;
            }
            tokens.push({ text: bin, type: TokenType.NUMBER, line: lineNum });
            continue;
        }

        // Decimal numbers
        if (/\d/.test(ch)) {
            let num = '';
            while (i < codePart.length && /\d/.test(codePart[i])) {
                num += codePart[i];
                i++;
            }
            tokens.push({ text: num, type: TokenType.NUMBER, line: lineNum });
            continue;
        }

        // String/char literals
        if (ch === '"' || ch === "'") {
            const quote = ch;
            let str = ch;
            i++;
            while (i < codePart.length && codePart[i] !== quote) {
                str += codePart[i];
                i++;
            }
            if (i < codePart.length) {
                str += codePart[i];
                i++;
            }
            tokens.push({ text: str, type: TokenType.STRING, line: lineNum });
            continue;
        }

        // Registers and special chars
        if ('#,()XYxy'.includes(ch)) {
            tokens.push({ text: ch, type: TokenType.PUNCTUATION, line: lineNum });
            i++;
            continue;
        }

        // Labels/identifiers
        if (/[A-Za-z_]/.test(ch)) {
            let id = '';
            while (i < codePart.length && /[A-Za-z0-9_]/.test(codePart[i])) {
                id += codePart[i];
                i++;
            }
            tokens.push({ text: id, type: TokenType.VARIABLE, line: lineNum });
            continue;
        }

        tokens.push({ text: ch, type: TokenType.DEFAULT, line: lineNum });
        i++;
    }

    // Add comment
    if (commentPart) {
        tokens.push({ text: commentPart, type: TokenType.COMMENT, line: lineNum });
    }

    return tokens;
}

// ============================================================================
// EXPORTS
// ============================================================================

export default BASICTokenizer;
