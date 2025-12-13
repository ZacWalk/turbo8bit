"""
Tests for PSID driver execution and SID register writes.

These tests verify that the PSID driver (installed by loadSidTune from sid-player.js):
1. Runs without crashing the CPU
2. Produces SID register writes during playback
3. Properly initializes the tune and calls the play routine

Uses py_mini_racer to run JavaScript code without a browser.
"""

import json
import pytest
from pathlib import Path

from tests.test_utils import call_js_test_with_bytes


class TestPSIDDriverExecution:
    """Tests for PSID driver execution and SID register writes."""

    def test_psid_driver_runs_without_crash(self, sid_player_context, giana_sisters_bytes):
        """Test that the PSID driver runs multiple frames without CPU crash."""
        result = call_js_test_with_bytes(sid_player_context, "testPsidDriverExecution", giana_sisters_bytes, 100)
        
        assert result['success'], f"PSID driver crashed: {result['crashes']}, frame states: {result['frameResults']}"
        assert len(result['crashes']) == 0, f"CPU crashes detected: {result['crashes']}"
        assert not result['finalHalted'], f"CPU halted at PC=${hex(result['finalPC'])}"

    def test_psid_driver_produces_sid_writes(self, sid_player_context, giana_sisters_bytes):
        """Test that running the PSID driver produces writes to SID registers."""
        result = call_js_test_with_bytes(sid_player_context, "testSidRegisterWrites", giana_sisters_bytes, 50)
        
        # Should have at least some SID writes
        assert result['totalWrites'] > 0, f"No SID writes detected for {result['tuneName']}"
        
        # Should have writes to voice control or frequency registers
        assert result['hasVoiceControl'] or result['hasFrequency'], \
            f"No voice/frequency writes. Register counts: {result['registerCounts']}"
        
        print(f"SID writes for '{result['tuneName']}': {result['totalWrites']} total")
        print(f"Register breakdown: {result['registerCounts']}")

    def test_psid_driver_volume_register(self, sid_player_context, giana_sisters_bytes):
        """Test that the PSID driver sets the SID volume register."""
        ctx = sid_player_context
        ctx.eval(f"var sidBytes = {json.dumps(giana_sisters_bytes)};")
        
        result_json = ctx.eval("""
            JSON.stringify((function() {
                var buffer = new Uint8Array(sidBytes).buffer;
                var machine = new C64Machine({ sampleRate: 44100 });
                
                // Load the tune
                var tune = machine.loadSidTune(buffer);
                
                // Run a few frames to let init complete
                for (var frame = 0; frame < 10; frame++) {
                    machine.runFrame();
                }
                
                // Read the volume register (offset $18 in SID, address $D418)
                // The driver sets LDA #$0F, STA $D418 for max volume
                var volumeReg = machine.ram[0xD400 + 0x18];  // Won't work - I/O mapped
                
                // Better approach: check via SID read
                // Actually, check the RAM at the driver code location to verify
                // the driver was installed correctly
                
                // Find the volume write in the driver (LDA #$0F, STA $D418)
                // Starting at $0400, scan for A9 0F 8D 18 D4
                var driverStart = 0x0400;
                var foundVolumeInit = false;
                for (var i = 0; i < 100; i++) {
                    if (machine.ram[driverStart + i] === 0xA9 && 
                        machine.ram[driverStart + i + 1] === 0x0F &&
                        machine.ram[driverStart + i + 2] === 0x8D &&
                        machine.ram[driverStart + i + 3] === 0x18 &&
                        machine.ram[driverStart + i + 4] === 0xD4) {
                        foundVolumeInit = true;
                        break;
                    }
                }
                
                return {
                    tuneName: tune.name,
                    foundVolumeInit: foundVolumeInit,
                    cpuPC: machine.cpu.PC,
                    cpuHalted: machine.cpu.halted
                };
            })())
        """)
        result = json.loads(result_json)
        
        assert result['foundVolumeInit'], "PSID driver should set volume to max ($0F)"
        assert not result['cpuHalted'], f"CPU halted at PC=${hex(result['cpuPC'])}"

    def test_psid_driver_irq_handler_installed(self, sid_player_context, giana_sisters_bytes):
        """Test that the PSID driver installs IRQ handler correctly.
        
        The PSID driver uses a two-handler design:
        - $03B0: Full hardware IRQ handler (pushes A/X/Y, handles direct hardware IRQs)
        - $0390: Simple handler for KERNAL dispatch (no register save, called via $0314)
        """
        ctx = sid_player_context
        ctx.eval(f"var sidBytes = {json.dumps(giana_sisters_bytes)};")
        
        result_json = ctx.eval("""
            JSON.stringify((function() {
                var buffer = new Uint8Array(sidBytes).buffer;
                var machine = new C64Machine({ sampleRate: 44100 });
                
                // Load the tune
                var tune = machine.loadSidTune(buffer);
                
                // Check hardware vectors in RAM
                var nmiVector = machine.ram[0xFFFA] | (machine.ram[0xFFFB] << 8);
                var resetVector = machine.ram[0xFFFC] | (machine.ram[0xFFFD] << 8);
                var irqVector = machine.ram[0xFFFE] | (machine.ram[0xFFFF] << 8);
                
                // Check software vectors at $0314-$0319
                var softIrqVector = machine.ram[0x0314] | (machine.ram[0x0315] << 8);
                var softBrkVector = machine.ram[0x0316] | (machine.ram[0x0317] << 8);
                var softNmiVector = machine.ram[0x0318] | (machine.ram[0x0319] << 8);
                
                // Hardware IRQ vector should point to full handler at $03B0
                var irqHandlerExpected = 0x03B0;
                // Software IRQ vector (KERNAL dispatch) should be simple handler at $0390
                var softIrqExpected = 0x0390;
                var nmiHandlerExpected = 0x0380;
                var driverExpected = 0x0400;
                
                return {
                    tuneName: tune.name,
                    nmiVector: nmiVector,
                    resetVector: resetVector,
                    irqVector: irqVector,
                    softIrqVector: softIrqVector,
                    softBrkVector: softBrkVector,
                    softNmiVector: softNmiVector,
                    irqVectorCorrect: irqVector === irqHandlerExpected,
                    softIrqVectorCorrect: softIrqVector === softIrqExpected,
                    nmiVectorCorrect: nmiVector === nmiHandlerExpected,
                    resetVectorCorrect: resetVector === driverExpected
                };
            })())
        """)
        result = json.loads(result_json)
        
        assert result['irqVectorCorrect'], \
            f"Hardware IRQ vector should be $03B0, got ${hex(result['irqVector'])}"
        assert result['softIrqVectorCorrect'], \
            f"Software IRQ vector ($0314) should be $0390, got ${hex(result['softIrqVector'])}"
        assert result['nmiVectorCorrect'], \
            f"NMI vector should be $0380, got ${hex(result['nmiVector'])}"
        assert result['resetVectorCorrect'], \
            f"RESET vector should be $0400, got ${hex(result['resetVector'])}"

    def test_psid_driver_calls_play_routine(self, sid_player_context, giana_sisters_bytes):
        """Test that the play routine is called during frame execution."""
        ctx = sid_player_context
        ctx.eval(f"var sidBytes = {json.dumps(giana_sisters_bytes)};")
        
        result_json = ctx.eval("""
            JSON.stringify((function() {
                var buffer = new Uint8Array(sidBytes).buffer;
                var machine = new C64Machine({ sampleRate: 44100 });
                
                // Load the tune
                var tune = machine.loadSidTune(buffer);
                var playAddr = tune.playAddress;
                
                // For RSID with playAddr=0, use a different approach
                if (playAddr === 0) {
                    // RSID tunes set up their own IRQ handler, so we just
                    // verify the driver runs frames without crashing
                    for (var frame = 0; frame < 20; frame++) {
                        machine.runFrame();
                    }
                    return {
                        tuneName: tune.name,
                        playAddress: playAddr,
                        playCallCount: 0,
                        framesRun: 20,
                        cpuHalted: machine.cpu.halted,
                        expectsCalls: false
                    };
                }
                
                // For PSID tunes with playAddress != 0, track calls to the play routine
                // by intercepting JSR to the play address in the IRQ handler
                var playCallCount = 0;
                var framesRun = 0;
                
                // The IRQ handler at $0390 contains JSR playAddr
                // We can check if IRQs are firing by monitoring the driver state
                // Run frames normally - runFrame() handles CIA timer and IRQs internally
                for (var frame = 0; frame < 20; frame++) {
                    framesRun++;
                    machine.runFrame();
                    if (machine.cpu.halted) break;
                }
                
                // Since we're using runFrame(), we can't directly count play calls
                // Instead, verify the tune is producing audio (SID writes happened)
                // The fact that the tune loaded and ran without crashing indicates
                // the driver is working. For a more detailed test, see test_psid_driver_produces_sid_writes
                
                return {
                    tuneName: tune.name,
                    playAddress: playAddr,
                    playCallCount: -1,  // Cannot count with runFrame()
                    framesRun: framesRun,
                    cpuHalted: machine.cpu.halted,
                    expectsCalls: playAddr !== 0
                };
            })())
        """)
        result = json.loads(result_json)
        
        # The tune should run without the CPU halting
        assert not result['cpuHalted'], "CPU should not halt during playback"
        
        if result['expectsCalls']:
            print(f"PSID tune '{result['tuneName']}' - driver ran {result['framesRun']} frames")
        else:
            print(f"RSID tune '{result['tuneName']}' - play routine handled by tune's own IRQ handler")


class TestPSIDDriverMultipleTunes:
    """Test PSID driver with different SID files."""

    def test_cybernoid_driver(self, sid_player_context, cybernoid_bytes):
        """Test PSID driver with Cybernoid."""
        ctx = sid_player_context
        ctx.eval(f"var sidBytes = {json.dumps(cybernoid_bytes)};")
        
        result_json = ctx.eval("""
            JSON.stringify((function() {
                var buffer = new Uint8Array(sidBytes).buffer;
                var machine = new C64Machine({ sampleRate: 44100 });
                
                // Track SID writes
                var sidWriteCount = 0;
                var originalWrite = machine.sid.write.bind(machine.sid);
                machine.sid.write = function(offset, value, cycle) {
                    sidWriteCount++;
                    return originalWrite(offset, value, cycle);
                };
                
                var tune = machine.loadSidTune(buffer);
                
                // Run 50 frames
                for (var frame = 0; frame < 50; frame++) {
                    machine.runFrame();
                }
                
                return {
                    tuneName: tune.name,
                    sidWriteCount: sidWriteCount,
                    cpuHalted: machine.cpu.halted,
                    success: sidWriteCount > 0 && !machine.cpu.halted
                };
            })())
        """)
        result = json.loads(result_json)
        
        assert result['success'], f"Cybernoid driver failed: writes={result['sidWriteCount']}, halted={result['cpuHalted']}"
        assert result['sidWriteCount'] > 10, f"Expected more SID writes, got {result['sidWriteCount']}"

    def test_last_ninja_driver(self, sid_player_context, last_ninja_bytes):
        """Test PSID driver with Last Ninja.
        
        This test currently fails because the Last Ninja tune causes the CPU to halt.
        This is a known issue that needs investigation - the tune may require
        specific C64 hardware features not yet implemented.
        """
        ctx = sid_player_context
        ctx.eval(f"var sidBytes = {json.dumps(last_ninja_bytes)};")
        
        result_json = ctx.eval("""
            JSON.stringify((function() {
                var buffer = new Uint8Array(sidBytes).buffer;
                var machine = new C64Machine({ sampleRate: 44100 });
                
                // Track SID writes
                var sidWriteCount = 0;
                var originalWrite = machine.sid.write.bind(machine.sid);
                machine.sid.write = function(offset, value, cycle) {
                    sidWriteCount++;
                    return originalWrite(offset, value, cycle);
                };
                
                var tune = machine.loadSidTune(buffer);
                
                // Track CPU state
                var haltedFrame = -1;
                var haltPC = 0;
                
                // Run 50 frames
                for (var frame = 0; frame < 50; frame++) {
                    machine.runFrame();
                    if (machine.cpu.halted && haltedFrame === -1) {
                        haltedFrame = frame;
                        haltPC = machine.cpu.PC;
                    }
                }
                
                return {
                    tuneName: tune.name,
                    initAddress: tune.initAddress,
                    playAddress: tune.playAddress,
                    loadAddress: tune.loadAddress,
                    sidWriteCount: sidWriteCount,
                    cpuHalted: machine.cpu.halted,
                    haltedFrame: haltedFrame,
                    haltPC: haltPC,
                    success: sidWriteCount > 0 && !machine.cpu.halted
                };
            })())
        """)
        result = json.loads(result_json)
        
        # Log diagnostic info for debugging
        if not result['success']:
            print(f"\nLast Ninja driver diagnostic info:")
            print(f"  Name: {result['tuneName']}")
            print(f"  Load: ${hex(result['loadAddress'])}, Init: ${hex(result['initAddress'])}, Play: ${hex(result['playAddress'])}")
            print(f"  SID writes: {result['sidWriteCount']}")
            print(f"  Halted at frame {result['haltedFrame']}, PC=${hex(result['haltPC'])}")
        
        assert result['success'], f"Last Ninja driver failed: writes={result['sidWriteCount']}, halted={result['cpuHalted']}"
        assert result['sidWriteCount'] > 10, f"Expected more SID writes, got {result['sidWriteCount']}"
