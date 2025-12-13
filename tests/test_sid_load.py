#!/usr/bin/env python3
"""
Test SID file loading and playback initialization.

This test verifies that:
1. SID files can be loaded and parsed correctly
2. The player can initialize properly
3. Audio samples can be generated
4. Great Giana Sisters track 1 starts properly

Uses py_mini_racer to run the JavaScript player in a test context.
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


def test_sid_parsing():
    """Test that SID files can be parsed correctly."""
    print("\n" + "=" * 70)
    print("Test 1: SID File Parsing")
    print("=" * 70)
    
    ctx = create_player_context()
    errors = []
    
    sid_files = list(SID_DIR.glob("*.sid"))
    if not sid_files:
        print("  ⚠ No SID files found in", SID_DIR)
        return False
    
    for sid_path in sid_files:
        sid_bytes = load_sid_file(sid_path)
        ctx.eval(f"var sidBytes = {json.dumps(sid_bytes)};")
        
        try:
            result = eval_json(ctx, """
                (function() {
                    try {
                        var buffer = new Uint8Array(sidBytes).buffer;
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
                            dataLength: info.data.length
                        };
                    } catch (e) {
                        return { success: false, error: e.toString() };
                    }
                })()
            """)
            
            if result['success']:
                print(f"\n  ✓ {sid_path.name}")
                print(f"    Magic: {result['magic']}, Songs: {result['songs']}")
                print(f"    Name: {result['name']}")
                print(f"    Author: {result['author']}")
                print(f"    Load: ${result['loadAddress']:04X}, Init: ${result['initAddress']:04X}, Play: ${result['playAddress']:04X}")
                print(f"    Data size: {result['dataLength']} bytes")
            else:
                print(f"\n  ✗ {sid_path.name}: {result['error']}")
                errors.append((sid_path.name, result['error']))
                
        except Exception as e:
            print(f"\n  ✗ {sid_path.name}: Exception - {e}")
            errors.append((sid_path.name, str(e)))
    
    if errors:
        print(f"\n  Failed: {len(errors)} of {len(sid_files)}")
        return False
    else:
        print(f"\n  All {len(sid_files)} SID files parsed successfully!")
        return True


def test_player_initialization():
    """Test that C64Machine can initialize tunes correctly."""
    print("\n" + "=" * 70)
    print("Test 2: C64Machine Initialization")
    print("=" * 70)
    
    ctx = create_player_context()
    errors = []
    
    sid_files = list(SID_DIR.glob("*.sid"))
    
    for sid_path in sid_files:
        sid_bytes = load_sid_file(sid_path)
        ctx.eval(f"var sidBytes = {json.dumps(sid_bytes)};")
        
        try:
            result = eval_json(ctx, """
                (function() {
                    try {
                        var buffer = new Uint8Array(sidBytes).buffer;
                        var machine = new C64Machine({ sampleRate: 44100 });
                        
                        // Load the tune
                        var tune = machine.loadSidTune(buffer);
                        
                        return {
                            success: true,
                            initialized: !!tune,
                            tuneLoaded: tune.name !== undefined,
                            clockFrequency: machine.clockFrequency,
                            cyclesPerFrame: machine.cyclesPerFrame,
                            name: tune.name
                        };
                    } catch (e) {
                        return { success: false, error: e.toString(), stack: e.stack || '' };
                    }
                })()
            """)
            
            if result['success'] and result['initialized']:
                print(f"\n  ✓ {sid_path.name}")
                print(f"    Tune loaded: {result['tuneLoaded']}")
                print(f"    Clock: {result['clockFrequency']} Hz, Cycles/Frame: {result['cyclesPerFrame']}")
            else:
                error = result.get('error', 'Not initialized')
                print(f"\n  ✗ {sid_path.name}: {error}")
                if result.get('stack'):
                    print(f"    Stack: {result['stack'][:200]}")
                errors.append((sid_path.name, error))
                
        except Exception as e:
            print(f"\n  ✗ {sid_path.name}: Exception - {e}")
            errors.append((sid_path.name, str(e)))
    
    if errors:
        print(f"\n  Failed: {len(errors)} of {len(sid_files)}")
        return False
    else:
        print(f"\n  All {len(sid_files)} tunes initialized successfully!")
        return True


def test_audio_generation():
    """Test that audio samples can be generated using C64Machine."""
    print("\n" + "=" * 70)
    print("Test 3: Audio Sample Generation")
    print("=" * 70)
    
    ctx = create_player_context()
    errors = []
    
    sid_files = list(SID_DIR.glob("*.sid"))
    
    for sid_path in sid_files:
        sid_bytes = load_sid_file(sid_path)
        ctx.eval(f"var sidBytes = {json.dumps(sid_bytes)};")
        
        try:
            result = eval_json(ctx, """
                (function() {
                    try {
                        var buffer = new Uint8Array(sidBytes).buffer;
                        var machine = new C64Machine({ audioEnabled: true });
                        
                        machine.loadSidTune(buffer);
                        
                        // Run frames and generate audio
                        var audioBuffer = new Int16Array(4096);
                        var totalSamples = 0;
                        var min = 0, max = 0, sum = 0, nonZero = 0;
                        
                        // Run for about 2 seconds (~100 frames at 50Hz)
                        for (var frame = 0; frame < 100; frame++) {
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
                        
                        var avg = sum / totalSamples;
                        var hasAudio = (max - min) > 100 && nonZero > 100;
                        
                        return {
                            success: true,
                            generated: totalSamples,
                            min: min / 32768.0,
                            max: max / 32768.0,
                            avg: avg / 32768.0,
                            nonZero: nonZero,
                            hasAudio: hasAudio
                        };
                    } catch (e) {
                        return { success: false, error: e.toString(), stack: e.stack || '' };
                    }
                })()
            """)
            
            if result['success']:
                status = "✓" if result['hasAudio'] else "⚠"
                print(f"\n  {status} {sid_path.name}")
                print(f"    Generated: {result['generated']} samples")
                print(f"    Range: [{result['min']:.4f}, {result['max']:.4f}], Avg: {result['avg']:.4f}")
                print(f"    Non-zero samples: {result['nonZero']}, Has audio: {result['hasAudio']}")
                
                if not result['hasAudio']:
                    errors.append((sid_path.name, "No audio generated"))
            else:
                print(f"\n  ✗ {sid_path.name}: {result['error']}")
                errors.append((sid_path.name, result['error']))
                
        except Exception as e:
            print(f"\n  ✗ {sid_path.name}: Exception - {e}")
            errors.append((sid_path.name, str(e)))
    
    if errors:
        print(f"\n  Issues: {len(errors)} of {len(sid_files)}")
        return False
    else:
        print(f"\n  All {len(sid_files)} tunes generate audio!")
        return True


def test_giana_sisters_track1():
    """Specific test for Great Giana Sisters Track 1."""
    print("\n" + "=" * 70)
    print("Test 4: Great Giana Sisters Track 1")
    print("=" * 70)
    
    sid_path = SID_DIR / "Great_Giana_Sisters.sid"
    if not sid_path.exists():
        print(f"  ⚠ File not found: {sid_path}")
        return False
    
    ctx = create_player_context()
    sid_bytes = load_sid_file(sid_path)
    ctx.eval(f"var sidBytes = {json.dumps(sid_bytes)};")
    
    try:
        # First, parse and show the tune info
        tune_info = eval_json(ctx, """
            (function() {
                var buffer = new Uint8Array(sidBytes).buffer;
                var info = parseSidFile(buffer);
                return {
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
        
        print(f"\n  Tune Info:")
        print(f"    Name: {tune_info['name']}")
        print(f"    Songs: {tune_info['songs']}, Start: {tune_info['startSong']}")
        print(f"    Load: ${tune_info['loadAddress']:04X}")
        print(f"    Init: ${tune_info['initAddress']:04X}")
        print(f"    Play: ${tune_info['playAddress']:04X}")
        print(f"    Speed: 0x{tune_info['speed']:08X}")
        
        # Now test track 1 initialization and playback using C64Machine
        result = eval_json(ctx, """
            (function() {
                var buffer = new Uint8Array(sidBytes).buffer;
                var machine = new C64Machine({ sampleRate: 44100 });
                
                var tune = machine.loadSidTune(buffer);
                var loadAddr = tune.loadAddress;
                var dataEnd = loadAddr + tune.data.length;
                
                // Track SID register writes
                var initWrites = 0;
                var writeLog = [];
                var ctrlWrites = [];
                var freqWrites = [];
                var originalWrite = machine.sid.write.bind(machine.sid);
                machine.sid.write = function(offset, value, cycle) {
                    initWrites++;
                    if (writeLog.length < 200) {
                        writeLog.push({r: offset, v: value});
                    }
                    if ((offset === 4 || offset === 0x0B || offset === 0x12) && ctrlWrites.length < 500) {
                        ctrlWrites.push({r: offset, v: value, w: initWrites});
                    }
                    if ((offset === 0 || offset === 1 || offset === 7 || offset === 8 || offset === 14 || offset === 15) && freqWrites.length < 50) {
                        freqWrites.push({r: offset, v: value, w: initWrites});
                    }
                    originalWrite(offset, value, cycle);
                };
                
                // Run initialization frames
                var initWriteCount = initWrites;
                
                // IRQ vector from memory
                var irqVector = machine.ram[0x0314] | (machine.ram[0x0315] << 8);
                
                // Run 150 frames and look for waveform bits
                var foundWaveform = false;
                var firstWaveformFrame = -1;
                for (var frame = 0; frame < 150; frame++) {
                    var ctrlCountBefore = ctrlWrites.length;
                    machine.runFrame();
                    
                    // Check if any new CTRL writes have waveform bits set
                    for (var i = ctrlCountBefore; i < ctrlWrites.length; i++) {
                        if ((ctrlWrites[i].v & 0xF0) !== 0) {
                            foundWaveform = true;
                            if (firstWaveformFrame < 0) {
                                firstWaveformFrame = frame;
                            }
                        }
                    }
                }
                var playWriteCount = initWrites - initWriteCount;
                
                // Generate some audio
                var audioBuffer = new Int16Array(4096);
                var generated = machine.generateAudio(audioBuffer);
                var samples = audioBuffer;
                
                // Analyze the audio
                var min = 0, max = 0, sum = 0, nonZero = 0;
                var first100 = [];
                var histogram = {};
                for (var i = 0; i < generated; i++) {
                    var s = samples[i] / 32768.0;
                    if (i < 100) first100.push(s);
                    if (s < min) min = s;
                    if (s > max) max = s;
                    sum += Math.abs(s);
                    if (Math.abs(s) > 0.001) nonZero++;
                    
                    var key = Math.round(s * 1000) / 1000;
                    histogram[key] = (histogram[key] || 0) + 1;
                }
                
                var histArray = [];
                for (var k in histogram) {
                    histArray.push({value: parseFloat(k), count: histogram[k]});
                }
                histArray.sort(function(a, b) { return b.count - a.count; });
                var topValues = histArray.slice(0, 10);
                
                // Check voice states
                var voices = [];
                for (var v = 0; v < 3; v++) {
                    voices.push({
                        waveform: machine.sid.voice[v].wave().waveform,
                        freq: machine.sid.voice[v].wave().freq,
                        pulseWidth: machine.sid.voice[v].wave().pw,
                        envelope: machine.sid.voice[v].envelope().output()
                    });
                }
                
                return {
                    success: true,
                    initWrites: initWriteCount,
                    playWrites: playWriteCount,
                    irqVector: irqVector,
                    generated: generated,
                    min: min,
                    max: max,
                    avg: sum / samples.length,
                    nonZero: nonZero,
                    hasAudio: (max - min) > 0.01 && nonZero > 100,
                    voices: voices,
                    first10Samples: first100.slice(0, 10),
                    topValues: topValues,
                    firstWrites: writeLog.slice(0, 100),
                    ctrlWrites: ctrlWrites.slice(0, 50),
                    freqWrites: freqWrites.slice(0, 20),
                    foundWaveform: foundWaveform,
                    firstWaveformFrame: firstWaveformFrame,
                    totalCtrlWrites: ctrlWrites.length,
                    loadAddr: loadAddr,
                    dataLength: tune.data.length
                };
            })()
        """)
        
        if result['success']:
            print(f"\n  Initialization:")
            print(f"    SID writes during init: {result['initWrites']}")
            print(f"    SID writes during 150 play frames: {result['playWrites']}")
            print(f"    IRQ vector at $0314: ${result.get('irqVector', 0):04X}")
            print(f"    Tune data: ${result['loadAddr']:04X}-${result['loadAddr'] + result['dataLength']:04X} ({result['dataLength']} bytes)")
            
            if result.get('playMemory'):
                mem_str = ' '.join(f'{b:02X}' for b in result['playMemory'])
                print(f"    Memory at play address: {mem_str}")
            
            # Show I/O reads
            print(f"\n  I/O Reads (top 15 addresses):")
            for io in result.get('ioReads', [])[:15]:
                addr = io['addr']
                count = io['count']
                # Name the address
                if addr >= 0xD400 and addr < 0xD420:
                    name = f"SID+${addr - 0xD400:02X}"
                elif addr >= 0xDC00 and addr < 0xDC10:
                    name = f"CIA1+${addr - 0xDC00:02X}"
                elif addr >= 0xDD00 and addr < 0xDD10:
                    name = f"CIA2+${addr - 0xDD00:02X}"
                elif addr >= 0xD000 and addr < 0xD040:
                    name = f"VIC+${addr - 0xD000:02X}"
                else:
                    name = "I/O"
                print(f"      ${addr:04X} ({name:12s}): {count} reads")
            
            # Show waveform detection results
            print(f"\n  Waveform Detection:")
            print(f"    Total CTRL writes: {result.get('totalCtrlWrites', 0)}")
            print(f"    Found waveform bits: {result.get('foundWaveform', False)}")
            if result.get('firstWaveformFrame', -1) >= 0:
                print(f"    First waveform at frame: {result['firstWaveformFrame']}")
            
            # Show first CTRL writes
            print(f"\n  First 20 CTRL register writes:")
            for w in result.get('ctrlWrites', [])[:20]:
                voice = {4: 1, 0x0B: 2, 0x12: 3}[w['r']]
                wave_bits = (w['v'] >> 4) & 0x0F
                gate = w['v'] & 0x01
                test = (w['v'] >> 3) & 0x01
                print(f"      Write #{w['w']:4d}: Voice {voice}: CTRL=${w['v']:02X} (wave={wave_bits}, test={test}, gate={gate})")
            
            print(f"\n  Voice States after 100 frames:")
            for i, voice in enumerate(result['voices']):
                print(f"    Voice {i}: wave=0x{voice['waveform']:02X}, freq={voice['freq']}, pw={voice['pulseWidth']}, env={voice['envelope']}")
            
            # Show frequency writes
            if result.get('freqWrites'):
                print(f"\n  First 10 frequency writes:")
                reg_names = {0: 'FREQ_LO1', 1: 'FREQ_HI1', 7: 'FREQ_LO2', 8: 'FREQ_HI2', 14: 'FREQ_LO3', 15: 'FREQ_HI3'}
                for w in result['freqWrites'][:10]:
                    name = reg_names.get(w['r'], f"REG{w['r']}")
                    print(f"      Write #{w['w']:4d}: {name} = ${w['v']:02X}")
            
            print(f"\n  Audio Generation:")
            print(f"    Generated: {result['generated']} samples")
            print(f"    Range: [{result['min']:.4f}, {result['max']:.4f}]")
            print(f"    Average: {result['avg']:.6f}")
            print(f"    Non-zero samples: {result['nonZero']}")
            
            print(f"\n  First 10 samples: {[f'{s:.4f}' for s in result['first10Samples']]}")
            
            print(f"\n  Top 10 most common sample values:")
            for tv in result.get('topValues', [])[:10]:
                pct = tv['count'] / result['generated'] * 100
                print(f"    {tv['value']:+.3f}: {tv['count']} ({pct:.1f}%)")
            
            if result['hasAudio']:
                print(f"\n  ✓ Track 1 generates audio!")
                return True
            else:
                print(f"\n  ✗ Track 1 does NOT generate audio!")
                return False
        else:
            print(f"\n  ✗ Test failed: {result.get('error', 'Unknown error')}")
            return False
            
    except Exception as e:
        print(f"\n  ✗ Exception: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_multi_track():
    """Test playing multiple tracks from a multi-track SID file."""
    print("\n" + "=" * 70)
    print("Test 5: Multi-Track Playback")
    print("=" * 70)
    
    sid_path = SID_DIR / "Great_Giana_Sisters.sid"
    if not sid_path.exists():
        print(f"  ⚠ File not found: {sid_path}")
        return False
    
    ctx = create_player_context()
    sid_bytes = load_sid_file(sid_path)
    ctx.eval(f"var sidBytes = {json.dumps(sid_bytes)};")
    
    errors = []
    
    # Get total songs
    total_songs = ctx.eval("""
        (function() {
            var buffer = new Uint8Array(sidBytes).buffer;
            var info = parseSidFile(buffer);
            return info.songs;
        })()
    """)
    
    print(f"\n  Testing {total_songs} tracks...")
    
    for track in range(1, min(total_songs + 1, 6)):  # Test first 5 tracks max
        result = eval_json(ctx, f"""
            (function() {{
                try {{
                    var buffer = new Uint8Array(sidBytes).buffer;
                    var machine = new C64Machine({{ audioEnabled: true }});
                    
                    machine.loadSidTune(buffer, {track});
                    
                    // Run frames and generate audio
                    var audioBuffer = new Int16Array(4096);
                    var min = 0, max = 0, nonZero = 0;
                    var totalGenerated = 0;
                    
                    // Run for about 0.5 seconds (~25 frames at 50Hz)
                    for (var frame = 0; frame < 25; frame++) {{
                        machine.runFrame(audioBuffer);
                        var generated = machine.generateAudio(audioBuffer);
                        totalGenerated += generated;
                        
                        for (var i = 0; i < generated; i++) {{
                            var s = audioBuffer[i];
                            if (s < min) min = s;
                            if (s > max) max = s;
                            if (s !== 0) nonZero++;
                        }}
                    }}
                    
                    return {{
                        success: true,
                        track: {track},
                        hasAudio: (max - min) > 100 && nonZero > 100,
                        range: (max - min) / 32768.0,
                        nonZero: nonZero
                    }};
                }} catch (e) {{
                    return {{ success: false, error: e.toString() }};
                }}
            }})()
        """)
        
        if result['success']:
            status = "✓" if result['hasAudio'] else "✗"
            print(f"    {status} Track {track}: range={result['range']:.4f}, nonZero={result['nonZero']}")
            if not result['hasAudio']:
                errors.append(f"Track {track}")
        else:
            print(f"    ✗ Track {track}: {result['error']}")
            errors.append(f"Track {track}")
    
    if errors:
        print(f"\n  Issues with: {', '.join(errors)}")
        return False
    else:
        print(f"\n  All tested tracks generate audio!")
        return True


def main():
    """Run all tests."""
    print("\n" + "=" * 70)
    print("SID File Load and Playback Tests")
    print("=" * 70)
    
    results = {
        "Parsing": test_sid_parsing(),
        "Initialization": test_player_initialization(),
        "Audio Generation": test_audio_generation(),
        "Giana Sisters Track 1": test_giana_sisters_track1(),
        "Multi-Track": test_multi_track(),
    }
    
    print("\n" + "=" * 70)
    print("Test Summary")
    print("=" * 70)
    
    passed = 0
    failed = 0
    for name, result in results.items():
        status = "✓ PASS" if result else "✗ FAIL"
        print(f"  {status}: {name}")
        if result:
            passed += 1
        else:
            failed += 1
    
    print(f"\n  Total: {passed} passed, {failed} failed")
    print("=" * 70 + "\n")
    
    return failed == 0


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
