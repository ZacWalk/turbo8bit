#!/usr/bin/env python3
"""
Test Great Giana Sisters timer logic.

This test verifies that the RSID file's init routine properly sets up
its own timer/interrupt handling and that it plays at the correct speed.
"""

import json

from tests.test_utils import (
    SID_DIR,
    load_sid_file,
    create_sid_player_context,
    eval_json,
)


def create_player_context():
    """Create a MiniRacer context with C64Machine loaded."""
    return create_sid_player_context()


def test_giana_timer_setup():
    """Test what timer configuration the Giana Sisters tune sets up."""
    print("\n" + "=" * 70)
    print("Test: Giana Sisters Timer Setup Analysis")
    print("=" * 70)
    
    sid_path = SID_DIR / "Great_Giana_Sisters.sid"
    if not sid_path.exists():
        print(f"  ⚠ File not found: {sid_path}")
        return False
    
    ctx = create_player_context()
    sid_bytes = load_sid_file(sid_path)
    ctx.eval(f"var sidBytes = {json.dumps(sid_bytes)};")
    
    # First, parse and show the tune info
    tune_info = eval_json(ctx, """
        (function() {
            var buffer = new Uint8Array(sidBytes).buffer;
            var info = parseSidFile(buffer);
            return {
                magic: info.magic,
                isRSID: info.isRSID,
                name: info.name,
                songs: info.songs,
                startSong: info.startSong,
                loadAddress: info.loadAddress,
                initAddress: info.initAddress,
                playAddress: info.playAddress,
                speed: info.speed
            };
        })()
    """)
    
    print(f"\n  File Type: {tune_info['magic']} (isRSID: {tune_info['isRSID']})")
    print(f"  Name: {tune_info['name']}")
    print(f"  Load: ${tune_info['loadAddress']:04X}")
    print(f"  Init: ${tune_info['initAddress']:04X}")
    print(f"  Play: ${tune_info['playAddress']:04X}")
    print(f"  Speed: 0x{tune_info['speed']:08X}")
    
    if tune_info['playAddress'] == 0:
        print("\n  NOTE: playAddress=0 means the tune sets up its own IRQ handler")
    
    # Check what the PSID driver generates
    driver_info = eval_json(ctx, """
        (function() {
            var buffer = new Uint8Array(sidBytes).buffer;
            var tune = parseSidFile(buffer);
            var driver = generatePsidDriver(tune, 0);
            return {
                useCIA: driver.debug.useCIA,
                timerValue: driver.debug.timerValue,
                initAddr: driver.debug.initAddr,
                playAddr: driver.debug.playAddr,
                initIoMap: driver.debug.initIoMap,
                playIoMap: driver.debug.playIoMap
            };
        })()
    """)
    
    print(f"\n  PSID Driver Config:")
    print(f"    useCIA: {driver_info['useCIA']}")
    print(f"    timerValue: ${driver_info['timerValue']:04X}")
    print(f"    initIoMap: ${driver_info['initIoMap']:02X}")
    print(f"    playIoMap: ${driver_info['playIoMap']:02X}")
    
    # Now load the tune and trace what timers get set up
    result = eval_json(ctx, """
        (function() {
            var buffer = new Uint8Array(sidBytes).buffer;
            var machine = new C64Machine({ sampleRate: 44100 });
            
            // Track CIA register writes during init AND frames
            var cia1Writes = [];
            var cia2Writes = [];
            var vicWrites = [];
            var vectorWrites = [];
            
            // Override write to track - BEFORE loadSidTune
            var origWrite = machine.write.bind(machine);
            machine.write = function(addr, val) {
                // CIA1 timer setup
                if (addr >= 0xDC00 && addr <= 0xDC0F && cia1Writes.length < 100) {
                    cia1Writes.push({addr: addr, val: val, reg: addr - 0xDC00, cycles: machine.cpu.cycles});
                }
                // CIA2 timer setup
                if (addr >= 0xDD00 && addr <= 0xDD0F && cia2Writes.length < 50) {
                    cia2Writes.push({addr: addr, val: val, reg: addr - 0xDD00});
                }
                // VIC IRQ setup
                if ((addr === 0xD011 || addr === 0xD012 || addr === 0xD019 || addr === 0xD01A) && vicWrites.length < 50) {
                    vicWrites.push({addr: addr, val: val, cycles: machine.cpu.cycles});
                }
                // IRQ/NMI vectors
                if (addr >= 0x0314 && addr <= 0x0319 && vectorWrites.length < 20) {
                    vectorWrites.push({addr: addr, val: val});
                }
                if (addr >= 0xFFFA && addr <= 0xFFFF && vectorWrites.length < 20) {
                    vectorWrites.push({addr: addr, val: val});
                }
                origWrite(addr, val);
            };
            
            // Load and run init using the loadSidTune function (not a method)
            loadSidTune(machine, buffer);
            
            // Mark the point where init loading ends
            var cyclesAtLoad = machine.cpu.cycles;
            
            // Run more frames to let init complete
            for (var i = 0; i < 10; i++) {
                machine.runFrame();
            }
            
            // Check the state after init
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
            
            // Get software IRQ vector
            var irqVector = machine.ram[0x0314] | (machine.ram[0x0315] << 8);
            var nmiVector = machine.ram[0x0318] | (machine.ram[0x0319] << 8);
            
            // Dump first 32 bytes of the tune's IRQ handler
            var irqHandlerCode = [];
            for (var i = 0; i < 32; i++) {
                irqHandlerCode.push(machine.ram[irqVector + i]);
            }
            
            return {
                cia1State: cia1State,
                cia2State: cia2State,
                vicState: vicState,
                irqVector: irqVector,
                nmiVector: nmiVector,
                irqHandlerCode: irqHandlerCode,
                cia1Writes: cia1Writes,
                cia2Writes: cia2Writes.slice(-20),
                vicWrites: vicWrites,
                vectorWrites: vectorWrites,
                cyclesAtLoad: cyclesAtLoad
            };
        })()
    """)
    
    print(f"\n  After Init + 3 frames - CIA1 State:")
    print(f"    Timer A Latch: ${result['cia1State']['timerALatch']:04X}")
    print(f"    Timer A Counter: ${result['cia1State'].get('timerACounter', 0):04X}")
    print(f"    Timer A Running: {result['cia1State']['timerARunning']}")
    print(f"    Timer A IRQ Enabled: {result['cia1State']['timerAIrqEnabled']}")
    print(f"    CRA: ${result['cia1State']['cra']:02X}")
    print(f"    ICR Mask: ${result['cia1State']['icrMask']:02X}")
    
    print(f"\n  After Init - CIA2 State:")
    print(f"    Timer A Latch: ${result['cia2State']['timerALatch']:04X}")
    print(f"    Timer A Running: {result['cia2State']['timerARunning']}")
    print(f"    Timer A NMI Enabled: {result['cia2State']['timerANmiEnabled']}")
    print(f"    CRA: ${result['cia2State']['cra']:02X}")
    print(f"    ICR Mask: ${result['cia2State']['icrMask']:02X}")
    
    print(f"\n  After Init - VIC State:")
    print(f"    Raster Compare: {result['vicState']['rasterCompare']}")
    print(f"    IRQ Enable: ${result['vicState']['irqEnable']:02X}")
    
    print(f"\n  Software Vectors:")
    print(f"    IRQ: ${result['irqVector']:04X}")
    print(f"    NMI: ${result['nmiVector']:04X}")
    
    # Show IRQ handler disassembly
    if 'irqHandlerCode' in result:
        print(f"\n  IRQ Handler at ${result['irqVector']:04X}:")
        code = result['irqHandlerCode']
        print(f"    " + " ".join(f"{b:02X}" for b in code[:16]))
        print(f"    " + " ".join(f"{b:02X}" for b in code[16:32]))
    
    if result['cia1Writes']:
        print(f"\n  CIA1 writes ({len(result['cia1Writes'])} total):")
        for w in result['cia1Writes'][:40]:
            reg_names = {4: "Timer A Lo", 5: "Timer A Hi", 0x0D: "ICR", 0x0E: "CRA", 0x0F: "CRB"}
            name = reg_names.get(w['reg'], f"reg {w['reg']}")
            print(f"    $DC{w['reg']:02X} ({name}) = ${w['val']:02X} @ cycle {w['cycles']}")
    
    if result['vicWrites']:
        print(f"\n  VIC writes ({len(result['vicWrites'])} total):")
        for w in result['vicWrites'][:30]:
            print(f"    ${w['addr']:04X} = ${w['val']:02X} @ cycle {w['cycles']}")
    
    # Calculate expected timer frequency
    cia1_latch = result['cia1State']['timerALatch']
    if cia1_latch > 0:
        freq = 985248 / (cia1_latch + 1)
        print(f"\n  Timer A Frequency: {freq:.2f} Hz (PAL clock)")
        if freq > 100:
            print(f"  ⚠ WARNING: Timer seems too fast for standard playback!")
    
    return True


def test_giana_irq_count():
    """Count IRQ triggers during playback to verify timing."""
    print("\n" + "=" * 70)
    print("Test: Giana Sisters IRQ Count (100 frames)")
    print("=" * 70)
    
    sid_path = SID_DIR / "Great_Giana_Sisters.sid"
    if not sid_path.exists():
        print(f"  ⚠ File not found: {sid_path}")
        return False
    
    ctx = create_player_context()
    sid_bytes = load_sid_file(sid_path)
    ctx.eval(f"var sidBytes = {json.dumps(sid_bytes)};")
    
    result = eval_json(ctx, """
        (function() {
            var buffer = new Uint8Array(sidBytes).buffer;
            var machine = new C64Machine({ sampleRate: 44100 });
            
            // Track IRQ/NMI triggers with sources
            var irqCount = 0;
            var nmiCount = 0;
            var vicIrqCount = 0;
            var cia1IrqCount = 0;
            var cia2NmiCount = 0;
            
            // Track raster compare changes
            var rasterCompareChanges = [];
            
            // Track raster line at each IRQ
            var irqRasterLines = [];
            
            // Load tune using the standalone function
            var tune = loadSidTune(machine, buffer);
            
            // Now track after init to see what's happening during playback
            // Override CPU IRQ/NMI triggers
            var origTriggerIRQ = machine.cpu.triggerIRQ.bind(machine.cpu);
            var origTriggerNMI = machine.cpu.triggerNMI.bind(machine.cpu);
            machine.cpu.triggerIRQ = function() {
                irqCount++;
                // Check what triggered it
                if (machine.vic.irqStatus & 0x80) {
                    vicIrqCount++;
                    if (irqRasterLines.length < 30) {
                        irqRasterLines.push({
                            line: machine.vic.lastRasterLine,
                            compare: machine.vic.rasterCompare,
                            cycle: machine.vic.rasterCycle
                        });
                    }
                }
                if (machine.cia1.icrData & 0x80) cia1IrqCount++;
                origTriggerIRQ();
            };
            machine.cpu.triggerNMI = function() {
                nmiCount++;
                if (machine.cia2.icrData & 0x80) cia2NmiCount++;
                origTriggerNMI();
            };
            
            // Track D012 writes (raster compare)
            var origWrite = machine.write.bind(machine);
            machine.write = function(addr, val) {
                if (addr === 0xD012 && rasterCompareChanges.length < 50) {
                    rasterCompareChanges.push({val: val, irqCount: irqCount});
                }
                origWrite(addr, val);
            };
            
            // Track SID writes during playback
            var sidWritesBefore = 0;
            var origSidWrite = machine.sid.write.bind(machine.sid);
            machine.sid.write = function(offset, value, cycle) {
                sidWritesBefore++;
                origSidWrite(offset, value, cycle);
            };
            
            // Check state before running frames
            var stateBeforeFrames = {
                cia1TimerARunning: machine.cia1.timerARunning,
                cia1TimerALatch: machine.cia1.timerALatch,
                cia1IrqEnabled: machine.cia1.timerAIrqEnabled,
                cia2TimerARunning: machine.cia2.timerARunning,
                cia2TimerALatch: machine.cia2.timerALatch,
                cia2NmiEnabled: machine.cia2.timerANmiEnabled,
                vicIrqEnable: machine.vic.irqEnable,
                vicRasterCompare: machine.vic.rasterCompare,
                vicRasterCycle: machine.vic.rasterCycle
            };
            
            // Run 10 frames only (to trace in detail)
            var frames = 10;
            for (var i = 0; i < frames; i++) {
                machine.runFrame();
            }
            
            // Check state after running
            var stateAfterFrames = {
                cia1TimerARunning: machine.cia1.timerARunning,
                cia1TimerALatch: machine.cia1.timerALatch,
                cia1IrqEnabled: machine.cia1.timerAIrqEnabled,
                cia2TimerARunning: machine.cia2.timerARunning,
                cia2TimerALatch: machine.cia2.timerALatch,
                cia2NmiEnabled: machine.cia2.timerANmiEnabled,
                vicIrqEnable: machine.vic.irqEnable,
                vicRasterCompare: machine.vic.rasterCompare,
                vicRasterCycle: machine.vic.rasterCycle,
                cyclesPerFrame: machine.cyclesPerFrame
            };
            
            var expectedIRQs = frames; // Should be ~1 IRQ per frame (50Hz)
            var irqsPerFrame = irqCount / frames;
            
            return {
                frames: frames,
                irqCount: irqCount,
                nmiCount: nmiCount,
                vicIrqCount: vicIrqCount,
                cia1IrqCount: cia1IrqCount,
                cia2NmiCount: cia2NmiCount,
                irqsPerFrame: irqsPerFrame,
                expectedIRQs: expectedIRQs,
                sidWrites: sidWritesBefore,
                sidWritesPerFrame: sidWritesBefore / frames,
                stateBeforeFrames: stateBeforeFrames,
                stateAfterFrames: stateAfterFrames,
                rasterCompareChanges: rasterCompareChanges,
                irqRasterLines: irqRasterLines,
                isSpeedOk: irqsPerFrame >= 0.5 && irqsPerFrame <= 2.0
            };
        })()
    """)
    
    print(f"\n  Frames run: {result['frames']}")
    print(f"  Total IRQ triggers: {result['irqCount']}")
    print(f"    - VIC raster IRQs: {result['vicIrqCount']}")
    print(f"    - CIA1 timer IRQs: {result['cia1IrqCount']}")
    print(f"  Total NMI triggers: {result['nmiCount']}")
    print(f"    - CIA2 timer NMIs: {result['cia2NmiCount']}")
    print(f"  IRQs per frame: {result['irqsPerFrame']:.2f}")
    print(f"  Expected IRQs (~1/frame): {result['expectedIRQs']}")
    print(f"  SID writes: {result['sidWrites']}")
    print(f"  SID writes per frame: {result['sidWritesPerFrame']:.1f}")
    
    print(f"\n  State BEFORE running frames:")
    s = result['stateBeforeFrames']
    print(f"    CIA1 Timer A: latch=${s['cia1TimerALatch']:04X}, running={s['cia1TimerARunning']}, irqEnabled={s['cia1IrqEnabled']}")
    print(f"    CIA2 Timer A: latch=${s['cia2TimerALatch']:04X}, running={s['cia2TimerARunning']}, nmiEnabled={s['cia2NmiEnabled']}")
    print(f"    VIC: irqEnable=${s['vicIrqEnable']:02X}, rasterCompare={s['vicRasterCompare']}, rasterCycle={s.get('vicRasterCycle', 'N/A')}")
    
    print(f"\n  State AFTER running frames:")
    s = result['stateAfterFrames']
    print(f"    CIA1 Timer A: latch=${s['cia1TimerALatch']:04X}, running={s['cia1TimerARunning']}, irqEnabled={s['cia1IrqEnabled']}")
    print(f"    CIA2 Timer A: latch=${s['cia2TimerALatch']:04X}, running={s['cia2TimerARunning']}, nmiEnabled={s['cia2NmiEnabled']}")
    print(f"    VIC: irqEnable=${s['vicIrqEnable']:02X}, rasterCompare={s['vicRasterCompare']}, rasterCycle={s.get('vicRasterCycle', 'N/A')}")
    print(f"    cyclesPerFrame: {s['cyclesPerFrame']}")
    
    if result.get('irqRasterLines'):
        print(f"\n  Raster lines at first {len(result['irqRasterLines'])} IRQs:")
        for i, info in enumerate(result['irqRasterLines'][:20]):
            print(f"    IRQ #{i+1}: line={info['line']}, compare={info['compare']}, cycle={info['cycle']}")
    
    if result['rasterCompareChanges']:
        print(f"\n  Raster compare (D012) writes (first {len(result['rasterCompareChanges'])}):")
        for i, change in enumerate(result['rasterCompareChanges'][:20]):
            print(f"    Write #{i+1}: D012=${change['val']:02X} (at IRQ #{change['irqCount']})")
    
    if result['irqsPerFrame'] > 2:
        print(f"\n  ⚠ WARNING: Too many IRQs per frame - playing too fast!")
        print(f"     This could cause the music to play at {result['irqsPerFrame']:.1f}x normal speed")
    elif result['irqsPerFrame'] < 0.5:
        print(f"\n  ⚠ WARNING: Too few IRQs per frame - playing too slow!")
    else:
        print(f"\n  ✓ IRQ rate looks correct")
    
    return result['isSpeedOk']


if __name__ == '__main__':
    test_giana_timer_setup()
    test_giana_irq_count()
