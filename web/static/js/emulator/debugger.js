//
// @fileoverview C64 Debugger - Step through assembly and view CPU state
// @module emulator/debugger
//
// Provides debugging capabilities for the C64 emulator:
// - Step through code instruction by instruction
// - Run until breakpoint or completion
// - View CPU register state
// - View memory contents
// - Set breakpoints
//
// Designed for educational purposes to help users understand:
// - How 6502 instructions work
// - How registers change with each instruction
// - How memory is accessed
// - How branches and loops work
//
// Usage:
//   import { C64Debugger } from './debugger.js';
//   import { C64Machine } from './machine.js';
//
//   const machine = new C64Machine();
//   const dbg = new C64Debugger(machine);
//   dbg.loadCode(bytes, 0x0800);
//   dbg.step();  // Execute one instruction
//   console.log(dbg.getState());  // See registers
//
// @see https://www.turbo8bit.com/
//

import { disassembleInstruction } from './assembler.js';

//
// Debugger state enum
//
export const DebuggerState = {
    STOPPED: 'stopped',
    RUNNING: 'running',
    PAUSED: 'paused',
    HALTED: 'halted'
};

//
// C64Debugger - Debug wrapper for C64Machine
//
// Provides step-by-step execution and state inspection
// for the C64 machine, useful for learning assembly.
//
export class C64Debugger {
    //
    // Create a debugger for a C64 machine
    // @param {C64Machine} machine - The machine to debug
    //
    constructor(machine) {
        this.machine = machine;
        this.cpu = machine.cpu;

        // Debugger state
        this.state = DebuggerState.STOPPED;
        this.breakpoints = new Set();
        this.watchpoints = new Map();  // address -> { read: bool, write: bool }

        // Execution history for learning
        this.history = [];
        this.maxHistoryLength = 100;

        // Callbacks
        this.onStateChange = null;
        this.onBreakpoint = null;
        this.onStep = null;

        // Loaded code info
        this.codeStart = 0;
        this.codeEnd = 0;
        this.codeBytes = null;

        // Running animation
        this.runIntervalId = null;
        this.runSpeed = 10;  // Instructions per interval
    }

    //
    // Load assembled code into memory
    // @param {Uint8Array} bytes - Machine code bytes
    // @param {number} startAddress - Address to load at
    //
    loadCode(bytes, startAddress) {
        this.codeStart = startAddress;
        this.codeEnd = startAddress + bytes.length;
        this.codeBytes = bytes;

        // Load into RAM
        for (let i = 0; i < bytes.length; i++) {
            this.machine.ram[startAddress + i] = bytes[i];
        }

        // Set PC to start of code
        this.cpu.PC = startAddress;

        // Reset debugger state
        this.state = DebuggerState.PAUSED;
        this.history = [];

        this.notifyStateChange();
    }

    //
    // Reset the CPU and reload the code
    //
    reset() {
        // Reset CPU state but keep RAM intact
        this.cpu.A = 0;
        this.cpu.X = 0;
        this.cpu.Y = 0;
        this.cpu.SP = 0xFF;
        this.cpu.P = 0x24;  // Interrupt disable set
        this.cpu.halted = false;

        // Reset PC to code start
        if (this.codeBytes) {
            this.cpu.PC = this.codeStart;
        }

        this.state = DebuggerState.PAUSED;
        this.history = [];
        this.stopRunning();

        this.notifyStateChange();
    }

    //
    // Execute a single instruction
    // @returns {Object} State after execution
    //
    step() {
        if (this.cpu.halted) {
            this.state = DebuggerState.HALTED;
            this.notifyStateChange();
            return this.getState();
        }

        // Record state before execution
        const prevState = this.getState();
        const prevPC = this.cpu.PC;

        // Disassemble current instruction before executing
        const instruction = disassembleInstruction(this.machine.ram, this.cpu.PC);

        // Execute one instruction
        const cycles = this.executeInstruction();

        // Record in history
        const entry = {
            pc: prevPC,
            instruction: instruction.text,
            bytes: instruction.bytes,
            cycles: cycles,
            before: prevState,
            after: this.getState()
        };

        this.history.push(entry);
        if (this.history.length > this.maxHistoryLength) {
            this.history.shift();
        }

        // Check for halted state
        if (this.cpu.halted) {
            this.state = DebuggerState.HALTED;
        }

        // Check for return to BASIC (RTS from our code)
        if (this.cpu.PC < this.codeStart || this.cpu.PC >= this.codeEnd) {
            // We've returned from our code
            if (instruction.mnemonic === 'RTS' || instruction.mnemonic === 'JMP') {
                this.state = DebuggerState.STOPPED;
                this.stopRunning();
            }
        }

        // Notify listeners
        if (this.onStep) {
            this.onStep(entry);
        }

        this.notifyStateChange();
        return this.getState();
    }

    //
    // Execute a single 6510 instruction
    // @returns {number} Cycles used
    // @private
    //
    executeInstruction() {
        const startCycles = this.cpu.cycles;

        // Execute until instruction completes (cycles change)
        // The 6510 step function executes one instruction
        this.cpu.step();

        return this.cpu.cycles - startCycles;
    }

    //
    // Run until breakpoint, halt, or stop
    //
    run() {
        if (this.state === DebuggerState.HALTED) {
            return;
        }

        this.state = DebuggerState.RUNNING;
        this.notifyStateChange();

        // Use setInterval for animated running
        this.runIntervalId = setInterval(() => {
            for (let i = 0; i < this.runSpeed; i++) {
                if (this.state !== DebuggerState.RUNNING) {
                    this.stopRunning();
                    return;
                }

                // Check for breakpoint before step
                if (this.breakpoints.has(this.cpu.PC) && this.history.length > 0) {
                    this.state = DebuggerState.PAUSED;
                    if (this.onBreakpoint) {
                        this.onBreakpoint(this.cpu.PC);
                    }
                    this.stopRunning();
                    this.notifyStateChange();
                    return;
                }

                this.step();

                // Check if we stopped (RTS, JMP out, or halted)
                if (this.state !== DebuggerState.RUNNING) {
                    this.stopRunning();
                    return;
                }
            }
        }, 50);  // 20 updates per second
    }

    //
    // Stop running
    //
    pause() {
        if (this.state === DebuggerState.RUNNING) {
            this.state = DebuggerState.PAUSED;
            this.stopRunning();
            this.notifyStateChange();
        }
    }

    //
    // Stop the run interval
    // @private
    //
    stopRunning() {
        if (this.runIntervalId) {
            clearInterval(this.runIntervalId);
            this.runIntervalId = null;
        }
    }

    //
    // Add a breakpoint
    // @param {number} address - Address to break at
    //
    addBreakpoint(address) {
        this.breakpoints.add(address);
    }

    //
    // Remove a breakpoint
    // @param {number} address - Address to remove breakpoint from
    //
    removeBreakpoint(address) {
        this.breakpoints.delete(address);
    }

    //
    // Clear all breakpoints
    //
    clearBreakpoints() {
        this.breakpoints.clear();
    }

    //
    // Get current CPU state
    // @returns {Object} CPU register state
    //
    getState() {
        return {
            A: this.cpu.A,
            X: this.cpu.X,
            Y: this.cpu.Y,
            SP: this.cpu.SP,
            PC: this.cpu.PC,
            P: this.cpu.P,
            flags: this.getFlags(),
            cycles: this.cpu.cycles
        };
    }

    //
    // Get processor flags as an object
    // @returns {Object} Flag states
    //
    getFlags() {
        const P = this.cpu.P;
        return {
            N: !!(P & 0x80),  // Negative
            V: !!(P & 0x40),  // Overflow
            B: !!(P & 0x10),  // Break
            D: !!(P & 0x08),  // Decimal
            I: !!(P & 0x04),  // Interrupt disable
            Z: !!(P & 0x02),  // Zero
            C: !!(P & 0x01)   // Carry
        };
    }

    //
    // Get formatted register state for display
    // @returns {string} Formatted register display
    //
    getFormattedState() {
        const s = this.getState();
        const f = s.flags;

        return [
            `PC: $${s.PC.toString(16).padStart(4, '0').toUpperCase()}`,
            `A:  $${s.A.toString(16).padStart(2, '0').toUpperCase()}  (${s.A})`,
            `X:  $${s.X.toString(16).padStart(2, '0').toUpperCase()}  (${s.X})`,
            `Y:  $${s.Y.toString(16).padStart(2, '0').toUpperCase()}  (${s.Y})`,
            `SP: $${s.SP.toString(16).padStart(2, '0').toUpperCase()}`,
            ``,
            `Flags: ${f.N ? 'N' : '-'}${f.V ? 'V' : '-'}-${f.B ? 'B' : '-'}${f.D ? 'D' : '-'}${f.I ? 'I' : '-'}${f.Z ? 'Z' : '-'}${f.C ? 'C' : '-'}`,
            `Cycles: ${s.cycles}`
        ].join('\n');
    }

    //
    // Disassemble a range of memory
    // @param {number} start - Start address
    // @param {number} count - Number of instructions
    // @returns {Array} Disassembled instructions
    //
    disassemble(start, count) {
        const instructions = [];
        let addr = start;

        for (let i = 0; i < count && addr < 0xFFFF; i++) {
            const instr = disassembleInstruction(this.machine.ram, addr);
            instructions.push({
                address: addr,
                bytes: instr.bytes,
                text: instr.text,
                isPC: addr === this.cpu.PC,
                isBreakpoint: this.breakpoints.has(addr)
            });
            addr += instr.size;
        }

        return instructions;
    }

    //
    // Get memory dump
    // @param {number} start - Start address
    // @param {number} length - Number of bytes
    // @returns {Uint8Array} Memory contents
    //
    getMemory(start, length) {
        return this.machine.ram.slice(start, start + length);
    }

    //
    // Format memory as hex dump
    // @param {number} start - Start address
    // @param {number} length - Number of bytes
    // @returns {string} Formatted hex dump
    //
    getFormattedMemory(start, length) {
        const lines = [];
        const bytesPerLine = 8;

        for (let i = 0; i < length; i += bytesPerLine) {
            const addr = start + i;
            const bytes = [];
            const chars = [];

            for (let j = 0; j < bytesPerLine && (i + j) < length; j++) {
                const byte = this.machine.ram[addr + j];
                bytes.push(byte.toString(16).padStart(2, '0').toUpperCase());
                chars.push(byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.');
            }

            lines.push(
                `$${addr.toString(16).padStart(4, '0').toUpperCase()}: ${bytes.join(' ').padEnd(23)} ${chars.join('')}`
            );
        }

        return lines.join('\n');
    }

    //
    // Get the stack contents
    // @returns {Array} Stack values from current SP to 0xFF
    //
    getStack() {
        const stack = [];
        for (let i = this.cpu.SP + 1; i <= 0xFF; i++) {
            stack.push({
                address: 0x0100 + i,
                value: this.machine.ram[0x0100 + i]
            });
        }
        return stack;
    }

    //
    // Notify state change callback
    // @private
    //
    notifyStateChange() {
        if (this.onStateChange) {
            this.onStateChange(this.state, this.getState());
        }
    }
}

// Export for browser usage
if (typeof window !== 'undefined') {
    window.C64Debugger = C64Debugger;
    window.DebuggerState = DebuggerState;
}
