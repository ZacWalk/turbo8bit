/**
 * Test helper functions for C64 emulator testing.
 * 
 * This library provides reusable JavaScript functions for testing
 * the C64 emulator in py_mini_racer. Functions return plain objects
 * that can be serialized to JSON for Python consumption.
 */

// =============================================================================
// C64 Machine Helpers
// =============================================================================

/**
 * Create a C64Machine and return basic info about it.
 */
function testC64MachineCreates() {
    var machine = new C64Machine();
    return {
        hasRam: machine.ram instanceof Uint8Array,
        ramSize: machine.ram.length,
        hasCpu: !!machine.cpu,
        hasSid: !!machine.sid
    };
}

/**
 * Test that CPU starts at the correct reset vector address.
 */
function testC64ResetVector() {
    var machine = new C64Machine();
    var resetLo = machine.read(0xFFFC);
    var resetHi = machine.read(0xFFFD);
    var resetVector = resetLo | (resetHi << 8);
    return {
        resetVector: resetVector,
        currentPC: machine.cpu.PC
    };
}

/**
 * Run the C64 for specified frames and check for READY prompt.
 * @param {number} frames - Number of frames to run (default 150)
 */
function testC64ReadyPrompt(frames) {
    frames = frames || 150;
    var machine = new C64Machine();
    
    for (var i = 0; i < frames; i++) {
        machine.runFrame();
    }
    
    // Read screen memory (starts at 0x0400)
    var rawChars = [];
    for (var i = 0; i < 1000; i++) {
        rawChars.push(machine.ram[0x0400 + i]);
    }
    
    // Count non-zero characters
    var nonZeroCount = 0;
    for (var i = 0; i < rawChars.length; i++) {
        if (rawChars[i] !== 0 && rawChars[i] !== 32) {
            nonZeroCount++;
        }
    }
    
    // Check if READY is present (screen codes: R=18, E=5, A=1, D=4, Y=25)
    var hasReady = false;
    for (var i = 0; i < rawChars.length - 5; i++) {
        if (rawChars[i] === 18 && rawChars[i+1] === 5 && 
            rawChars[i+2] === 1 && rawChars[i+3] === 4 && rawChars[i+4] === 25) {
            hasReady = true;
            break;
        }
    }
    
    return {
        nonZeroCount: nonZeroCount,
        hasReady: hasReady,
        cursorCol: machine.ram[0x00D3],
        cursorRow: machine.ram[0x00D6],
        cpuCycles: machine.cpu.cycles,
        cpuPC: machine.cpu.PC,
        firstChars: rawChars.slice(0, 40)
    };
}

// =============================================================================
// Memory Operations
// =============================================================================

/**
 * Test POKE operation - write to a single address.
 * @param {number} addr - Address to write to
 * @param {number} value - Value to write
 */
function testPoke(addr, value) {
    var machine = new C64Machine();
    var beforeValue = machine.ram[addr];
    machine.write(addr, value);
    var afterValue = machine.ram[addr];
    var readBackValue = machine.read(addr);
    
    return {
        beforeValue: beforeValue,
        afterValue: afterValue,
        readBackValue: readBackValue,
        testValue: value
    };
}

/**
 * Test POKE to multiple addresses.
 * @param {Array} tests - Array of {addr, val} objects
 */
function testPokeMultiple(tests) {
    var machine = new C64Machine();
    var results = [];
    
    for (var i = 0; i < tests.length; i++) {
        machine.write(tests[i].addr, tests[i].val);
        results.push({
            addr: tests[i].addr,
            expected: tests[i].val,
            actual: machine.read(tests[i].addr)
        });
    }
    
    return results;
}

// =============================================================================
// SID Parsing
// =============================================================================

/**
 * Parse a SID file and return info.
 * @param {Uint8Array} sidData - SID file data
 */
function testParseSidFile(sidData) {
    try {
        var buffer = sidData instanceof ArrayBuffer ? sidData : sidData.buffer;
        var info = parseSidFile(buffer);
        return {
            success: true,
            magic: info.magic,
            name: info.name,
            author: info.author,
            songs: info.songs,
            startSong: info.startSong,
            loadAddress: info.loadAddress,
            initAddress: info.initAddress,
            playAddress: info.playAddress,
            speed: info.speed,
            isRSID: info.isRSID,
            dataLength: info.data.length
        };
    } catch (e) {
        return { success: false, error: e.toString() };
    }
}

// =============================================================================
// SID Playback
// =============================================================================

/**
 * Load a SID tune into a C64Machine and return info.
 * @param {Uint8Array} sidData - SID file data
 * @param {Object} options - Machine options (sampleRate, etc.)
 */
function testLoadSidTune(sidData, options) {
    options = options || { sampleRate: 44100 };
    try {
        var buffer = sidData instanceof ArrayBuffer ? sidData : sidData.buffer;
        var machine = new C64Machine(options);
        var tune = machine.loadSidTune(buffer);
        
        return {
            success: true,
            initialized: !!tune,
            tuneLoaded: tune.name !== undefined,
            name: tune.name,
            author: tune.author,
            songs: tune.songs,
            startSong: tune.startSong,
            clockFrequency: machine.clockFrequency,
            cyclesPerFrame: machine.cyclesPerFrame
        };
    } catch (e) {
        return { success: false, error: e.toString(), stack: e.stack || '' };
    }
}

/**
 * Load a SID tune and generate audio samples.
 * @param {Uint8Array} sidData - SID file data
 * @param {number} frames - Number of frames to run (default 50)
 */
function testSidAudioGeneration(sidData, frames) {
    frames = frames || 50;
    try {
        var buffer = sidData instanceof ArrayBuffer ? sidData : sidData.buffer;
        var machine = new C64Machine({ audioEnabled: true });
        var tune = machine.loadSidTune(buffer);
        
        if (!tune) {
            return { success: false, error: 'Failed to load SID file' };
        }
        
        var audioBuffer = new Int16Array(4096);
        var totalSamples = 0;
        var min = 0, max = 0, sum = 0, nonZero = 0;
        
        for (var frame = 0; frame < frames; frame++) {
            machine.runFrame(audioBuffer);
            var generated = machine.generateAudio(audioBuffer);
            totalSamples += generated;
            
            for (var i = 0; i < generated; i++) {
                var s = audioBuffer[i];
                if (s < min) min = s;
                if (s > max) max = s;
                sum += Math.abs(s);
                if (s !== 0) nonZero++;
            }
        }
        
        var variation = max - min;
        
        return {
            success: true,
            loaded: true,
            tuneName: tune.name || 'Unknown',
            tuneAuthor: tune.author || 'Unknown',
            tuneSongs: tune.songs || 1,
            generated: totalSamples,
            min: min,
            max: max,
            minNorm: min / 32768.0,
            maxNorm: max / 32768.0,
            avg: sum / (totalSamples || 1),
            avgNorm: (sum / (totalSamples || 1)) / 32768.0,
            nonZero: nonZero,
            variation: variation,
            hasVariation: variation > 50,
            hasAudio: (max - min) > 100 && nonZero > 100
        };
    } catch (e) {
        return { success: false, error: e.toString(), stack: e.stack || '' };
    }
}

/**
 * Run PSID driver and check for crashes.
 * @param {Uint8Array} sidData - SID file data
 * @param {number} frames - Number of frames to run (default 100)
 */
function testPsidDriverExecution(sidData, frames) {
    frames = frames || 100;
    try {
        var buffer = sidData instanceof ArrayBuffer ? sidData : sidData.buffer;
        var machine = new C64Machine({ sampleRate: 44100 });
        var tune = machine.loadSidTune(buffer);
        
        var initialPC = machine.cpu.PC;
        var crashes = [];
        var frameResults = [];
        
        for (var frame = 0; frame < frames; frame++) {
            var haltedBefore = machine.cpu.halted;
            
            try {
                machine.runFrame();
            } catch (e) {
                crashes.push({
                    frame: frame,
                    error: e.message || String(e),
                    pc: machine.cpu.PC
                });
            }
            
            if (machine.cpu.halted && !haltedBefore) {
                crashes.push({
                    frame: frame,
                    error: 'CPU halted unexpectedly',
                    pc: machine.cpu.PC
                });
            }
            
            if (frame % 10 === 0) {
                frameResults.push({
                    frame: frame,
                    pc: machine.cpu.PC,
                    halted: machine.cpu.halted,
                    sp: machine.cpu.SP
                });
            }
        }
        
        return {
            tuneName: tune.name,
            initialPC: initialPC,
            finalPC: machine.cpu.PC,
            finalHalted: machine.cpu.halted,
            crashes: crashes,
            frameResults: frameResults,
            success: crashes.length === 0 && !machine.cpu.halted
        };
    } catch (e) {
        return { success: false, error: e.toString() };
    }
}

// =============================================================================
// SID Register Tracking
// =============================================================================

/**
 * Track SID register writes during playback.
 * @param {Uint8Array} sidData - SID file data
 * @param {number} frames - Number of frames to run (default 50)
 */
function testSidRegisterWrites(sidData, frames) {
    frames = frames || 50;
    try {
        var buffer = sidData instanceof ArrayBuffer ? sidData : sidData.buffer;
        var machine = new C64Machine({ audioEnabled: true });
        
        // Track SID writes
        var sidWrites = [];
        var originalWrite = machine.sid.write.bind(machine.sid);
        machine.sid.write = function(offset, value, cycle) {
            if (sidWrites.length < 500) {
                sidWrites.push({ offset: offset, value: value, addr: 0xD400 + offset });
            }
            return originalWrite(offset, value, cycle);
        };
        
        var tune = machine.loadSidTune(buffer);
        
        for (var frame = 0; frame < frames; frame++) {
            machine.runFrame();
        }
        
        // Analyze writes by register
        var registerCounts = {};
        for (var i = 0; i < sidWrites.length; i++) {
            var offset = sidWrites[i].offset;
            registerCounts[offset] = (registerCounts[offset] || 0) + 1;
        }
        
        // Check for voice control writes (registers $04, $0B, $12)
        var hasVoiceControl = !!(registerCounts[0x04] || registerCounts[0x0B] || registerCounts[0x12]);
        // Check for frequency writes (registers $00-$01, $07-$08, $0E-$0F)
        var hasFrequency = !!(registerCounts[0x00] || registerCounts[0x01] || 
                              registerCounts[0x07] || registerCounts[0x08] ||
                              registerCounts[0x0E] || registerCounts[0x0F]);
        
        return {
            tuneName: tune.name,
            totalWrites: sidWrites.length,
            registerCounts: registerCounts,
            hasVoiceControl: hasVoiceControl,
            hasFrequency: hasFrequency,
            sampleWrites: sidWrites.slice(0, 20),
            pc: machine.cpu.PC
        };
    } catch (e) {
        return { success: false, error: e.toString() };
    }
}

// =============================================================================
// CPU Testing
// =============================================================================

/**
 * Test CPU memory operations.
 */
function testCpuMemoryOps() {
    var memory = new Uint8Array(65536);
    var bus = {
        read: function(addr) { return memory[addr]; },
        write: function(addr, val) { memory[addr] = val; }
    };
    var cpu = new MOS6510(bus);
    
    memory[0x0400] = 0x42;
    memory[0x0401] = 0xFF;
    memory[0x0402] = 0x00;
    
    return {
        val1: cpu.read(0x0400),
        val2: cpu.read(0x0401),
        val3: cpu.read(0x0402)
    };
}

/**
 * Test CPU register operations.
 */
function testCpuRegisterOps() {
    var memory = new Uint8Array(65536);
    var bus = {
        read: function(addr) { return memory[addr]; },
        write: function(addr, val) { memory[addr] = val; }
    };
    var cpu = new MOS6510(bus);
    
    cpu.A = 0x55;
    cpu.X = 0xAA;
    cpu.Y = 0x33;
    cpu.SP = 0xFF;
    
    return {
        a: cpu.A,
        x: cpu.X,
        y: cpu.Y,
        sp: cpu.SP
    };
}

// =============================================================================
// SID Chip Testing
// =============================================================================

/**
 * Test SID register writes.
 */
function testSidWriteRegisters() {
    var sid = new SID();
    sid.reset();
    
    sid.write(0x00, 0x33);  // Freq lo voice 1
    sid.write(0x01, 0x1D);  // Freq hi voice 1
    sid.write(0x04, 0x11);  // Control voice 1 (gate + triangle)
    sid.write(0x05, 0x09);  // Attack/Decay
    sid.write(0x06, 0xF0);  // Sustain/Release
    sid.write(0x18, 0x0F);  // Volume 15
    
    return {
        success: true,
        volume: sid.read(0x18) & 0x0F
    };
}

/**
 * Test SID clocking produces samples.
 */
function testSidClockCycles() {
    var sid = new SID();
    sid.reset();
    
    // Configure a simple tone
    sid.write(0x00, 0x00);  // Freq lo
    sid.write(0x01, 0x20);  // Freq hi
    sid.write(0x02, 0x00);  // Pulse width lo
    sid.write(0x03, 0x08);  // Pulse width hi (50%)
    sid.write(0x05, 0x00);  // Attack 0, Decay 0
    sid.write(0x06, 0xF0);  // Sustain max, Release 0
    sid.write(0x04, 0x41);  // Gate on, pulse wave
    sid.write(0x18, 0x0F);  // Volume max
    
    var samples = [];
    for (var i = 0; i < 1000; i++) {
        var sample = sid.clock();
        if (i % 100 === 0) samples.push(sample);
    }
    
    var min = Math.min.apply(null, samples);
    var max = Math.max.apply(null, samples);
    
    return {
        sampleCount: samples.length,
        min: min,
        max: max,
        hasVariation: max !== min
    };
}

// =============================================================================
// Envelope Generator Testing
// =============================================================================

/**
 * Test envelope attack phase.
 */
function testEnvelopeAttack() {
    var env = new EnvelopeGenerator();
    env.reset();
    
    env.writeATTACK_DECAY(0x00);
    env.writeSUSTAIN_RELEASE(0xF0);
    env.writeCONTROL_REG(0x01);
    
    var outputs = [];
    for (var i = 0; i < 100; i++) {
        env.clock();
        if (i % 10 === 0) outputs.push(env.output());
    }
    
    return {
        outputs: outputs,
        firstOutput: outputs[0],
        lastOutput: outputs[outputs.length - 1]
    };
}

// =============================================================================
// Waveform Generator Testing
// =============================================================================

/**
 * Test waveform generator creation.
 */
function testWaveformGeneratorCreation() {
    var wave = new WaveformGenerator();
    
    return {
        success: true,
        hasAccumulator: typeof wave.accumulator !== 'undefined',
        hasFreq: typeof wave.freq !== 'undefined',
        hasPw: typeof wave.pw !== 'undefined'
    };
}

// =============================================================================
// CIA Timer Testing
// =============================================================================

/**
 * Track timer configuration during tune initialization.
 * @param {Uint8Array} sidData - SID file data
 * @param {number} frames - Number of frames to run after init (default 10)
 */
function testTimerSetup(sidData, frames) {
    frames = frames || 10;
    try {
        var buffer = sidData instanceof ArrayBuffer ? sidData : sidData.buffer;
        var machine = new C64Machine({ sampleRate: 44100 });
        
        var cia1Writes = [];
        var cia2Writes = [];
        var vicWrites = [];
        var vectorWrites = [];
        
        var origWrite = machine.write.bind(machine);
        machine.write = function(addr, val) {
            if (addr >= 0xDC00 && addr <= 0xDC0F && cia1Writes.length < 100) {
                cia1Writes.push({addr: addr, val: val, reg: addr - 0xDC00, cycles: machine.cpu.cycles});
            }
            if (addr >= 0xDD00 && addr <= 0xDD0F && cia2Writes.length < 50) {
                cia2Writes.push({addr: addr, val: val, reg: addr - 0xDD00});
            }
            if ((addr === 0xD011 || addr === 0xD012 || addr === 0xD019 || addr === 0xD01A) && vicWrites.length < 50) {
                vicWrites.push({addr: addr, val: val, cycles: machine.cpu.cycles});
            }
            if (addr >= 0x0314 && addr <= 0x0319 && vectorWrites.length < 20) {
                vectorWrites.push({addr: addr, val: val});
            }
            origWrite(addr, val);
        };
        
        var tune = machine.loadSidTune(buffer);
        var cyclesAtLoad = machine.cpu.cycles;
        
        for (var i = 0; i < frames; i++) {
            machine.runFrame();
        }
        
        var cia1State = {
            timerALatch: machine.cia1.timerALatch,
            timerACounter: machine.cia1.timerACounter,
            timerARunning: machine.cia1.timerARunning,
            timerAIrqEnabled: machine.cia1.timerAIrqEnabled,
            cra: machine.cia1.cra,
            icrMask: machine.cia1.icrMask
        };
        
        var cia2State = {
            timerALatch: machine.cia2.timerALatch,
            timerARunning: machine.cia2.timerARunning,
            timerANmiEnabled: machine.cia2.timerANmiEnabled,
            cra: machine.cia2.cra,
            icrMask: machine.cia2.icrMask
        };
        
        var vicState = {
            rasterCompare: machine.vic.rasterCompare,
            irqEnable: machine.vic.irqEnable
        };
        
        var irqVector = machine.ram[0x0314] | (machine.ram[0x0315] << 8);
        var nmiVector = machine.ram[0x0318] | (machine.ram[0x0319] << 8);
        
        return {
            tuneName: tune.name,
            cia1State: cia1State,
            cia2State: cia2State,
            vicState: vicState,
            irqVector: irqVector,
            nmiVector: nmiVector,
            cia1Writes: cia1Writes,
            cia2Writes: cia2Writes,
            vicWrites: vicWrites,
            vectorWrites: vectorWrites,
            cyclesAtLoad: cyclesAtLoad
        };
    } catch (e) {
        return { success: false, error: e.toString() };
    }
}

// =============================================================================
// C64Machine SID Playback (full test)
// =============================================================================

/**
 * Full C64Machine SID playback test with timing verification.
 * @param {Uint8Array} sidData - SID file data
 * @param {number} frames - Number of frames to run (default 10)
 */
function testC64MachineSidPlayback(sidData, frames) {
    frames = frames || 10;
    try {
        var buffer = sidData instanceof ArrayBuffer ? sidData : sidData.buffer;
        var machine = new C64Machine({ audioEnabled: true });
        var tune = machine.loadSidTune(buffer);
        
        if (!tune) {
            return { error: 'Failed to load SID file', loaded: false };
        }
        
        var audioBuffer = new Int16Array(4096);
        var totalSamples = 0;
        var nonZeroCount = 0;
        var maxAmplitude = 0;
        
        for (var frame = 0; frame < frames; frame++) {
            machine.runFrame(audioBuffer);
            var samplesThisFrame = machine.generateAudio(audioBuffer);
            totalSamples += samplesThisFrame;
            
            for (var i = 0; i < samplesThisFrame; i++) {
                if (audioBuffer[i] !== 0) {
                    nonZeroCount++;
                    var absVal = Math.abs(audioBuffer[i]);
                    if (absVal > maxAmplitude) maxAmplitude = absVal;
                }
            }
        }
        
        return {
            loaded: true,
            tuneName: tune.name || 'Unknown',
            tuneAuthor: tune.author || 'Unknown',
            tuneSongs: tune.songs || 1,
            totalSamples: totalSamples,
            nonZeroSamples: nonZeroCount,
            maxAmplitude: maxAmplitude,
            hasAudio: nonZeroCount > 0,
            cpuPC: machine.cpu.PC,
            cia1Running: machine.cia1.timerARunning,
            vicIrqEnabled: machine.vic.irqEnable ? true : false
        };
    } catch (e) {
        return { error: e.message, loaded: false };
    }
}

// =============================================================================
// Cartridge Testing
// =============================================================================

/**
 * Load and parse a CRT cartridge file.
 * @param {Uint8Array} crtData - CRT file data
 */
function testLoadCartridge(crtData) {
    try {
        var cart = new Cartridge();
        var buffer = crtData instanceof ArrayBuffer ? crtData : crtData.buffer;
        var success = cart.load(buffer);
        
        return {
            success: success,
            type: cart.hardwareType,
            exrom: cart.exrom,
            game: cart.game,
            bankCount: cart.banks.length,
            enabled: cart.enabled,
            name: cart.name
        };
    } catch (e) {
        return { success: false, error: e.toString() };
    }
}

/**
 * Load a cartridge into C64Machine and run it.
 * @param {Uint8Array} crtData - CRT file data
 * @param {number} frames - Number of frames to run
 */
function testRunCartridge(crtData, frames) {
    frames = frames || 100;
    try {
        var machine = new C64Machine();
        var buffer = crtData instanceof ArrayBuffer ? crtData : crtData.buffer;
        var loaded = machine.loadCartridge(buffer);
        
        if (!loaded) {
            return { success: false, error: 'Failed to load cartridge' };
        }
        
        machine.reset();
        
        var pcHistory = [];
        for (var frame = 0; frame < frames; frame++) {
            machine.runFrame();
            if (frame % 10 === 0) {
                pcHistory.push(machine.cpu.PC);
            }
        }
        
        return {
            success: true,
            cartridgeEnabled: machine.cartridge.enabled,
            finalPC: machine.cpu.PC,
            pcHistory: pcHistory,
            cpuHalted: machine.cpu.halted
        };
    } catch (e) {
        return { success: false, error: e.toString() };
    }
}

// =============================================================================
// SID Direct Register Test (for I/O mapping)
// =============================================================================

/**
 * Test SID register writes via I/O mapping.
 */
function testSidRegisterWriteViaIO() {
    var machine = new C64Machine();
    var sidBase = 0xD400;
    
    machine.write(sidBase + 0, 0x12);  // Freq Lo
    machine.write(sidBase + 1, 0x34);  // Freq Hi
    machine.write(sidBase + 5, 0x09);  // Attack/Decay
    machine.write(sidBase + 6, 0xA0);  // Sustain/Release
    machine.write(sidBase + 4, 0x11);  // Triangle + gate
    
    var buffer = new Int16Array(100);
    machine.runFrame();
    var samplesGenerated = machine.generateAudio(buffer);
    
    var hasSound = false;
    for (var i = 0; i < samplesGenerated; i++) {
        if (buffer[i] !== 0) {
            hasSound = true;
            break;
        }
    }
    
    return {
        samplesGenerated: samplesGenerated,
        hasSound: hasSound
    };
}

// =============================================================================
// Assembler Testing
// =============================================================================

/**
 * Assemble code and return result.
 * @param {string} code - Assembly source code
 */
function testAssemble(code) {
    var asm = new Assembler();
    var result = asm.assemble(code);
    return {
        success: result.success,
        errors: result.errors.map(function(e) { 
            return { lineNum: e.lineNum, message: e.message }; 
        }),
        bytes: Array.from(result.bytes),
        byteCount: result.bytes.length,
        symbols: result.symbols
    };
}
