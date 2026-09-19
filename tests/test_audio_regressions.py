"""SID format, waveform, driver, and browser-player contract regressions."""

import json
from pathlib import Path

import pytest

from tests import test_giana_timer, test_sid_load
from tests.test_utils import create_sid_player_context, eval_json


@pytest.fixture
def audio_context():
    ctx = create_sid_player_context()
    ctx.eval(
        """
        function makeSid(options = {}) {
            const isRSID = options.isRSID || false;
            const version = options.version === undefined ? 2 : options.version;
            const headerSize = version === 1 ? 118 : 124;
            const address = options.address === undefined ? 0x1000 : options.address;
            const embedded = isRSID || options.embedded;
            const program = options.program || [0x60, 0x60];
            const bytes = new Uint8Array(headerSize + program.length + (embedded ? 2 : 0));
            const view = new DataView(bytes.buffer);
            view.setUint32(0, isRSID ? 0x52534944 : 0x50534944);
            view.setUint16(4, version);
            view.setUint16(6, headerSize);
            view.setUint16(8, embedded ? 0 : address);
            view.setUint16(10, options.init === undefined ? address : options.init);
            view.setUint16(12, options.play === undefined ? (isRSID ? 0 : address + 1) : options.play);
            view.setUint16(14, options.songs === undefined ? 3 : options.songs);
            view.setUint16(16, options.startSong === undefined ? 1 : options.startSong);
            view.setUint32(18, options.speed || 0);
            const name = options.name || 'Synthetic SID';
            for (let i = 0; i < Math.min(32, name.length); i++) bytes[22 + i] = name.charCodeAt(i);
            if (version !== 1) {
                view.setUint16(118, options.flags === undefined ? 0x14 : options.flags);
                bytes[120] = options.startPage || 0;
                bytes[121] = options.pageLength || 0;
                bytes[122] = options.secondSID || 0;
                bytes[123] = options.thirdSID || 0;
            }
            if (embedded) bytes.set([address & 255, address >> 8], headerSize);
            bytes.set(program, headerSize + (embedded ? 2 : 0));
            return bytes.buffer;
        }
        """
    )
    return ctx


def run_async(ctx, body):
    ctx.eval(
        "var asyncResult = null; var asyncError = null;"
        "(async () => {" + body + "})()"
        ".then(value => { asyncResult = JSON.stringify(value); })"
        ".catch(error => { asyncError = String(error.stack || error); });"
    )
    for _ in range(10):
        error = ctx.eval("asyncError")
        assert error is None, error
        result = ctx.eval("asyncResult")
        if result is not None:
            return json.loads(result)
    pytest.fail("The controlled audio operation did not settle")


@pytest.fixture
def browser_audio_context(audio_context):
    audio_context.eval(
        """
        var audioHarness = {
            nodes: [], contexts: [], resumes: [], modules: [], moduleCalls: 0, revoked: 0,
            state: 'running', sampleRate: 44100, worklet: false,
            delayResume: false, delayModule: false, failResume: false,
            failModule: false, failWorkletConnect: false, failScript: false
        };
        class MockAudioNode {
            constructor(kind) {
                this.kind = kind;
                this.connected = false;
                this.messages = 0;
                this.closed = false;
                this.port = {
                    onmessage: null,
                    postMessage: () => { this.messages++; },
                    close: () => { this.closed = true; }
                };
                audioHarness.nodes.push(this);
            }
            connect() {
                this.connected = true;
                if (this.kind === 'worklet' && audioHarness.failWorkletConnect) {
                    throw new Error('Worklet connection failed');
                }
            }
            disconnect() { this.connected = false; }
        }
        var AudioWorkletNode = class extends MockAudioNode {
            constructor() { super('worklet'); }
        };
        var Blob = function() {};
        var URL = {
            createObjectURL() { return 'blob:audio-test'; },
            revokeObjectURL() { audioHarness.revoked++; }
        };
        window.AudioContext = class {
            constructor() {
                this.sampleRate = audioHarness.sampleRate;
                this.state = audioHarness.state;
                this.destination = {};
                audioHarness.contexts.push(this);
                if (audioHarness.worklet) {
                    this.audioWorklet = {addModule: () => {
                        audioHarness.moduleCalls++;
                        if (audioHarness.failModule) return Promise.reject(new Error('Module failed'));
                        if (audioHarness.delayModule) {
                            return new Promise(resolve => audioHarness.modules.push(resolve));
                        }
                        return Promise.resolve();
                    }};
                }
            }
            resume() {
                if (audioHarness.failResume) return Promise.reject(new Error('Resume denied'));
                if (audioHarness.delayResume) {
                    return new Promise(resolve => audioHarness.resumes.push(() => {
                        this.state = 'running';
                        resolve();
                    }));
                }
                this.state = 'running';
                return Promise.resolve();
            }
            createScriptProcessor() {
                if (audioHarness.failScript) throw new Error('ScriptProcessor failed');
                return new MockAudioNode('script');
            }
        };
        function connectedNodes() { return audioHarness.nodes.filter(node => node.connected).length; }
        var player = new SIDPlayer();
        player.loadData(makeSid());
        """
    )
    return audio_context


@pytest.mark.parametrize("previous", [0, 0x10, 0x20, 0x30])
def test_pure_pulse_does_not_keep_previous_waveform(audio_context, previous):
    result = eval_json(
        audio_context,
        f"""(() => {{
            const wave = new SID().voice[0].wave();
            wave.writeCONTROL_REG({previous});
            wave.writeCONTROL_REG(0x40);
            wave.accumulator = 0x345000;
            wave.pulseOutput = 0xfff;
            return {{output: wave.output(), table: wave.modelWave.indexOf(wave.wave)}};
        }})()""",
    )
    assert result == {"output": 4095, "table": 0}


@pytest.mark.parametrize("selector", range(16))
def test_waveform_table_selection_follows_bitfields(audio_context, selector):
    result = eval_json(
        audio_context,
        f"""(() => {{
            const wave = new SID().voice[0].wave();
            wave.writeCONTROL_REG({selector} << 4);
            wave.setWaveformModels(wave.modelWave);
            wave.setPulldownModels(wave.modelPulldown);
            return {{
                base: wave.modelWave.indexOf(wave.wave),
                pulldown: wave.modelPulldown.indexOf(wave.pulldown),
                pulseMask: wave.noPulse
            }};
        }})()""",
    )
    pulldown = {3: 0, 5: 1, 6: 2, 7: 3}.get(selector & 7, -1)
    if selector == 12:
        pulldown = 4
    assert result == {
        "base": selector & 3,
        "pulldown": pulldown,
        "pulseMask": 0 if selector & 4 else 4095,
    }


def test_combined_waveform_accepts_zero_table_output(audio_context):
    result = eval_json(
        audio_context,
        """(() => {
            const wave = new SID().voice[0].wave();
            wave.writeCONTROL_REG(0x30);
            wave.accumulator = 0x3000;
            wave.triSawPipeline = 2;
            return {raw: wave.wave[3], mapped: wave.pulldown[2],
                    actual: wave.output(), osc3: wave.osc3};
        })()""",
    )
    assert result["raw"] != 0
    assert result["mapped"] == result["actual"] == result["osc3"] == 0


@pytest.mark.parametrize(
    "options",
    [
        {"version": 0},
        {"version": 5},
        {"isRSID": True, "version": 1},
        {"songs": 0},
        {"songs": 257},
        {"startSong": 0},
        {"songs": 1, "startSong": 2},
        {"flags": 1},
        {"flags": 2},
        {"isRSID": True, "flags": 2},
        {"secondSID": 0x42, "version": 3},
        {"thirdSID": 0x44, "version": 4},
        {"address": 0xFFFF},
        {"program": []},
        {"isRSID": True, "speed": 1},
        {"isRSID": True, "play": 0x1001},
        {"isRSID": True, "address": 0x0400},
        {"startPage": 0, "pageLength": 1},
        {"startPage": 0xFF, "pageLength": 1},
        {"startPage": 0x80, "pageLength": 0x81},
    ],
)
def test_reject_unsupported_or_invalid_sid_headers(audio_context, options):
    result = eval_json(
        audio_context,
        f"""(() => {{
            try {{ parseSidFile(makeSid({json.dumps(options)})); return {{rejected: false}}; }}
            catch (error) {{ return {{rejected: true, message: error.message}}; }}
        }})()""",
    )
    assert result["rejected"], options
    assert result["message"]


def test_driver_relocates_instead_of_overwriting_program(audio_context):
    result = eval_json(
        audio_context,
        """(() => {
            const bytes = makeSid({address: 0x0400, program: [0x60, 0xee, 0, 0x20, 0x60]});
            const tune = parseSidFile(bytes);
            const driver = generatePsidDriver(tune, 0);
            const machine = new C64Machine();
            loadSidTune(machine, bytes);
            const preserved = Array.from(machine.ram.slice(0x400, 0x405));
            const audio = new Int16Array(4096);
            for (let i = 0; i < 5; i++) machine.runFrame(audio);
            return {preserved, playCount: machine.ram[0x2000],
                    driverAddress: driver.cpuState.PC, halted: machine.cpu.halted};
        })()""",
    )
    assert result["preserved"] == [0x60, 0xEE, 0, 0x20, 0x60]
    assert result["driverAddress"] != 0x0400
    assert result["playCount"] > 0
    assert not result["halted"]


@pytest.mark.parametrize("is_rsid", [False, True])
def test_self_managed_irq_keeps_init_banking_and_timer_control(audio_context, is_rsid):
    result = eval_json(
        audio_context,
        f"""(() => {{
            const program = [
                0xa9, 0x35, 0x85, 0x01,
                0xa9, 0x40, 0x8d, 0xfe, 0xff, 0xa9, 0x10, 0x8d, 0xff, 0xff,
                0xa9, 1, 0x8d, 0x1a, 0xd0,
                0xa9, 0, 0x8d, 0x12, 0xd0, 0x8d, 0x0e, 0xdc,
                0xa9, 0x1b, 0x8d, 0x11, 0xd0, 0x60
            ];
            while (program.length < 64) program.push(0);
            program.push(0xee, 0, 0x20, 0xa9, 0xff, 0x8d, 0x19, 0xd0, 0x40);
            const machine = new C64Machine();
            loadSidTune(machine, makeSid({{isRSID: {str(is_rsid).lower()}, play: 0, program}}));
            const audio = new Int16Array(4096);
            for (let i = 0; i < 5; i++) machine.runFrame(audio);
            return {{bank: machine.ram[1], irqCount: machine.ram[0x2000],
                     timerRunning: machine.cia1.timerARunning, halted: machine.cpu.halted}};
        }})()""",
    )
    assert result["bank"] == 0x35
    assert result["irqCount"] > 0
    assert not result["timerRunning"]
    assert not result["halted"]


@pytest.mark.parametrize(
    "options",
    [{"version": version} for version in range(1, 5)]
    + [{"isRSID": True, "version": version} for version in range(2, 5)],
)
def test_supported_single_sid_versions_parse(audio_context, options):
    result = eval_json(
        audio_context,
        f"""(() => {{
            const tune = parseSidFile(makeSid({json.dumps(options)}));
            return {{version: tune.version, data: Array.from(tune.data),
                     load: tune.loadAddress, songs: tune.songs}};
        }})()""",
    )
    assert result == {
        "version": options["version"],
        "data": [0x60, 0x60],
        "load": 0x1000,
        "songs": 3,
    }


@pytest.mark.parametrize("length", [0, 7, 8, 117, 118, 123])
def test_truncated_headers_have_explicit_errors(audio_context, length):
    result = eval_json(
        audio_context,
        f"""(() => {{
            try {{parseSidFile(makeSid().slice(0, {length})); return null;}}
            catch (error) {{return {{name: error.name, message: error.message}};}}
        }})()""",
    )
    assert result["name"] == "Error"
    assert "header" in result["message"]


@pytest.mark.parametrize(
    "mutation",
    [
        "view.setUint16(6, 118)",
        "view.setUint16(6, bytes.byteLength)",
        "view.setUint16(8, 0); bytes = bytes.slice(0, 125)",
        "view.setUint16(8, 0); bytes = bytes.slice(0, 126)",
        "view.setUint16(118, 0x8000)",
        "view.setUint32(0, 0x52534944)",
    ],
)
def test_offsets_embedded_addresses_and_reserved_fields_are_checked(
    audio_context, mutation
):
    result = eval_json(
        audio_context,
        f"""(() => {{
            let bytes = makeSid();
            const view = new DataView(bytes);
            {mutation};
            try {{ parseSidFile(bytes); return false; }} catch {{ return true; }}
        }})()""",
    )
    assert result


def test_driver_obeys_declared_relocation_window(audio_context):
    result = eval_json(
        audio_context,
        """(() => {
            const tune = parseSidFile(makeSid({startPage: 8, pageLength: 1}));
            const driver = generatePsidDriver(tune, 0);
            const code = driver.regions.filter(region => region.address !== 0x0314 &&
                region.address !== 0xfffa);
            return {addresses: driver.addresses,
                fits: code.every(region => region.address >= 0x800 &&
                    region.address + region.data.length <= 0x900)};
        })()""",
    )
    assert result["fits"]
    assert result["addresses"]["driver"] == 0x880
    assert result["addresses"]["nmi"] == 0x800


@pytest.mark.parametrize(
    "options",
    [
        {"startPage": 0xFF},
        {"startPage": 0x10, "pageLength": 1},
        {"startPage": 0xA0, "pageLength": 1},
        {"startPage": 0xCF, "pageLength": 2},
        {"address": 0x0314},
        {"address": 0xFFFA},
        {"address": 0x0100},
    ],
)
def test_driver_placement_failure_does_not_reset_machine(audio_context, options):
    result = eval_json(
        audio_context,
        f"""(() => {{
            const machine = new C64Machine();
            loadSidTune(machine, makeSid());
            machine.ram[0x2000] = 0x77;
            const pc = machine.cpu.PC;
            let rejected = false;
            try {{ loadSidTune(machine, makeSid({json.dumps(options)})); }}
            catch {{ rejected = true; }}
            return {{rejected, samePC: pc === machine.cpu.PC, sentinel: machine.ram[0x2000]}};
        }})()""",
    )
    assert result == {"rejected": True, "samePC": True, "sentinel": 0x77}


def test_frame_fifo_preserves_samples_across_arbitrary_callback_sizes(audio_context):
    result = eval_json(
        audio_context,
        """(() => {
            const player = new SIDPlayer();
            let nextSample = 0, frames = 0;
            player.machine = {
                cpu: {halted: false},
                runFrame(buffer) {
                    frames++;
                    for (let i = 0; i < 7; i++) buffer[i] = nextSample++;
                    this.audioSamplesGenerated = 7;
                    return 19000;
                },
                sid: {clock() {throw new Error('Do not clock SID outside runFrame');}}
            };
            player.sidFile = {clock: CLOCK_PAL};
            player.isPlaying = true;
            const samples = [];
            for (const size of [1, 1, 2, 7, 3, 17]) {
                const output = new Float32Array(size);
                player.generateSamples(output);
                samples.push(...Array.from(output, value => value * 32768));
            }
            return {samples, frames, queued: player._frameSampleCount - player._frameReadIndex,
                capacity: player._frameBuffer.length};
        })()""",
    )
    assert result["samples"] == list(range(31))
    assert result["frames"] == 5
    assert result["queued"] == 4
    assert result["capacity"] < 1024


def test_real_audio_is_independent_of_callback_partition(audio_context):
    result = eval_json(
        audio_context,
        """(() => {
            const bytes = makeSid({play: 0x100e, program: [
                0xa9, 0x20, 0x8d, 0x01, 0xd4,
                0xa9, 0xf0, 0x8d, 0x06, 0xd4,
                0xa9, 0x21, 0x8d, 0x04, 0xd4, 0x60, 0x60
            ]});
            // Init ends at $100F; the play routine is the following RTS.
            new DataView(bytes).setUint16(12, 0x1010);
            const whole = new SIDPlayer(), split = new SIDPlayer();
            whole.loadData(bytes); split.loadData(bytes);
            whole.isPlaying = split.isPlaying = true;
            const expected = new Float32Array(4096);
            whole.generateSamples(expected);
            const actual = [];
            for (const size of [1, 37, 1000, 53, 3005]) {
                const output = new Float32Array(size);
                split.generateSamples(output);
                actual.push(...output);
            }
            return {equal: actual.every((value, index) => value === expected[index]),
                nonzero: expected.some(value => value !== 0), length: actual.length};
        })()""",
    )
    assert result == {"equal": True, "nonzero": True, "length": 4096}


def test_sid_reads_advance_inside_each_cpu_frame(audio_context):
    result = eval_json(
        audio_context,
        """(() => {
            const player = new SIDPlayer();
            player.loadData(makeSid({play: 0x100e, program: [
                0xa9, 0xff, 0x8d, 0x0e, 0xd4, 0x8d, 0x0f, 0xd4,
                0xa9, 0x20, 0x8d, 0x12, 0xd4, 0x60,
                0xa2, 0xff, 0xad, 0x1b, 0xd4, 0x29, 0x0f,
                0x8d, 0x18, 0xd4, 0xca, 0xd0, 0xf5, 0x60
            ]}));
            const perFrame = new Map();
            const write = player.machine.sid.write.bind(player.machine.sid);
            player.machine.sid.write = (offset, value, cycle) => {
                if (offset === 24) {
                    if (!perFrame.has(player._frameCount)) perFrame.set(player._frameCount, new Set());
                    perFrame.get(player._frameCount).add(value);
                }
                write(offset, value, cycle);
            };
            player.isPlaying = true;
            player.generateSamples(new Float32Array(4096));
            return Array.from(perFrame.values(), values => values.size);
        })()""",
    )
    assert result
    assert max(result) > 1, "OSC3 must not stay frozen during an entire CPU frame"


def test_init_and_visualization_clock_sid_without_retaining_audio(audio_context):
    result = eval_json(
        audio_context,
        """(() => {
            const player = new SIDPlayer();
            player.loadData(makeSid({play: 0x1001, program: [0x60, 0xee, 0x18, 0xd4, 0x60]}));
            const initialized = player.machine.sid.currentCycle;
            const runFrame = player.machine.runFrame.bind(player.machine);
            let buffered = true;
            player.machine.runFrame = buffer => {
                buffered = buffered && buffer instanceof Int16Array;
                return runFrame(buffer);
            };
            player.runInitFrames(3);
            player.isPlaying = true;
            let maxPending = 0;
            for (let i = 0; i < 100; i++) {
                player.runVisualizationFrame();
                maxPending = Math.max(maxPending, player.machine.sid.writeQueue.length);
            }
            return {initialized, advanced: player.machine.sid.currentCycle > initialized,
                buffered, maxPending, queuedAudio: player._frameSampleCount,
                logSize: player.registerWriteLog.length};
        })()""",
    )
    assert result["initialized"] > 0
    assert result["advanced"] and result["buffered"]
    assert result["maxPending"] < 10
    assert result["queuedAudio"] == 0
    assert result["logSize"] <= 100


def test_invalid_frame_sample_count_fails_instead_of_spinning(audio_context):
    result = eval_json(
        audio_context,
        """(() => {
            const player = new SIDPlayer();
            let calls = 0;
            player.machine = {runFrame() {calls++; this.audioSamplesGenerated = 0;}};
            player.sidFile = {clock: CLOCK_PAL};
            player.isPlaying = true;
            try {player.generateSamples(new Float32Array(32)); return {rejected: false};}
            catch (error) {return {rejected: true, calls, message: error.message};}
        })()""",
    )
    assert result["rejected"] and result["calls"] == 1
    assert "sample count" in result["message"]


@pytest.mark.parametrize(
    "selection",
    [
        "new ArrayBuffer(0)",
        "makeSid({startPage: 0xff})",
        "makeSid({program: [0x02], play: 0x1000})",
    ],
)
def test_failed_load_preserves_the_playing_session(browser_audio_context, selection):
    result = run_async(
        browser_audio_context,
        """
        await player.play();
        const machine = player.machine, tune = player.sidFile, node = player.scriptNode;
        const registers = player.registers, log = player.registerWriteLog;
        let rejected = false;
        try { player.loadData("""
        + selection
        + """); } catch { rejected = true; }
        return {rejected, playing: player.isPlaying, sameMachine: machine === player.machine,
            sameTune: tune === player.sidFile, sameNode: node === player.scriptNode,
            sameRegisters: registers === player.registers, sameLog: log === player.registerWriteLog,
            connected: connectedNodes()};
        """,
    )
    assert result == {
        "rejected": True,
        "playing": True,
        "sameMachine": True,
        "sameTune": True,
        "sameNode": True,
        "sameRegisters": True,
        "sameLog": True,
        "connected": 1,
    }


def test_successful_load_stops_and_commits_clean_state(browser_audio_context):
    result = run_async(
        browser_audio_context,
        """
        await player.play();
        const oldMachine = player.machine;
        player.generateSamples(new Float32Array(3));
        player.registers[31] = 255;
        const metadata = player.loadData(makeSid({name: 'Replacement', startSong: 2}));
        return {name: metadata.name, song: player.currentSong, playing: player.isPlaying,
            connected: connectedNodes(), replaced: player.machine !== oldMachine,
            frame: player._frameCount, queued: player._frameSampleCount, register31: player.registers[31]};
        """,
    )
    assert result == {
        "name": "Replacement",
        "song": 1,
        "playing": False,
        "connected": 0,
        "replaced": True,
        "frame": 0,
        "queued": 0,
        "register31": 0,
    }


@pytest.mark.parametrize("track", [-1, 3, 0.5, None, "1"])
def test_invalid_track_preserves_playing_selection(browser_audio_context, track):
    result = run_async(
        browser_audio_context,
        """
        await player.play();
        const machine = player.machine;
        let rejected = false;
        try {player.changeTrack("""
        + json.dumps(track)
        + """);} catch {rejected = true;}
        return {rejected, playing: player.isPlaying, song: player.currentSong,
            sameMachine: machine === player.machine, connected: connectedNodes()};
        """,
    )
    assert result == {
        "rejected": True,
        "playing": True,
        "song": 0,
        "sameMachine": True,
        "connected": 1,
    }


def test_failed_track_initialization_preserves_playback(browser_audio_context):
    result = run_async(
        browser_audio_context,
        """
        player.loadData(makeSid({play: 0x1006, program: [0xc9, 1, 0xf0, 1, 0x60, 0x02, 0x60]}));
        await player.play();
        const machine = player.machine;
        let rejected = false;
        try {player.changeTrack(1);} catch {rejected = true;}
        return {rejected, sameMachine: machine === player.machine,
            playing: player.isPlaying, song: player.currentSong, connected: connectedNodes()};
        """,
    )
    assert result == {
        "rejected": True,
        "sameMachine": True,
        "playing": True,
        "song": 0,
        "connected": 1,
    }


def test_track_success_stops_and_preserves_audio_configuration(browser_audio_context):
    result = run_async(
        browser_audio_context,
        """
        audioHarness.sampleRate = 48000;
        player.loadData(makeSid({flags: 0x28}));
        await player.play();
        player.generateSamples(new Float32Array(3));
        player.changeTrack(1);
        return {song: player.currentSong, playing: player.isPlaying,
            connected: connectedNodes(), frame: player._frameCount, queued: player._frameSampleCount,
            rate: player.sampleRate, machineRate: player.machine.sampleRate,
            sidRate: player.machine.sid.samplingFrequency,
            ntsc: player.machine.clockFrequency === CLOCK_NTSC, model: player.machine.sid.model};
        """,
    )
    assert result == {
        "song": 1,
        "playing": False,
        "connected": 0,
        "frame": 0,
        "queued": 0,
        "rate": 48000,
        "machineRate": 48000,
        "sidRate": 48000,
        "ntsc": True,
        "model": "MOS8580",
    }


def test_track_change_preserves_live_model_and_clock_overrides(audio_context):
    result = eval_json(
        audio_context,
        """(() => {
            const player = new SIDPlayer();
            player.loadData(makeSid());
            player.machine.sid.setChipModel(ChipModel.MOS8580);
            player.machine.clockFrequency = CLOCK_NTSC;
            player.machine.cyclesPerFrame = Math.floor(CLOCK_NTSC / 60);
            player.changeTrack(1);
            return {clock: player.machine.clockFrequency, model: player.machine.sid.model,
                cycles: player.machine.cyclesPerFrame, expectedClock: CLOCK_NTSC,
                expectedCycles: Math.floor(CLOCK_NTSC / 60)};
        })()""",
    )
    assert result["clock"] == result["expectedClock"]
    assert result["cycles"] == result["expectedCycles"]
    assert result["model"] == "MOS8580"


@pytest.mark.parametrize(
    ("flags", "expected_calls", "frame_cycles", "clock"),
    [(0x14, 51, 19656, 985248), (0x18, 60, 17095, 1022727)],
)
def test_raster_timed_tunes_keep_pal_and_ntsc_tempo(
    audio_context, flags, expected_calls, frame_cycles, clock
):
    result = eval_json(
        audio_context,
        f"""(() => {{
            const player = new SIDPlayer();
            player.loadData(makeSid({{
                flags: {flags}, program: [0x60, 0xEE, 0x00, 0x20, 0x60]
            }}));
            const before = player.machine.ram[0x2000];
            player.isPlaying = true;
            player.generateSamples(new Float32Array(player.sampleRate));
            return {{
                calls: (player.machine.ram[0x2000] - before) & 255,
                frames: player._frameCount,
                budget: player.machine.cyclesPerFrame,
                samplesPerFrame: player.samplesPerFrame,
                elapsed: player.getState().elapsedTime
            }};
        }})()""",
    )
    assert abs(result["calls"] - expected_calls) <= 1
    assert result["budget"] == frame_cycles
    assert result["samplesPerFrame"] == pytest.approx(44100 * frame_cycles / clock)
    assert result["elapsed"] == pytest.approx(result["frames"] * frame_cycles / clock)


def test_play_is_idempotent_while_starting_and_playing(browser_audio_context):
    result = run_async(
        browser_audio_context,
        """
        const first = player.play(), second = player.play();
        const samePromise = first === second;
        await first;
        await player.play();
        const playing = player.isPlaying, connected = connectedNodes();
        player.stop(); player.stop();
        return {samePromise, playing, connected, created: audioHarness.nodes.length,
            stopped: !player.isPlaying, remaining: connectedNodes()};
        """,
    )
    assert result == {
        "samePromise": True,
        "playing": True,
        "connected": 1,
        "created": 1,
        "stopped": True,
        "remaining": 0,
    }


@pytest.mark.parametrize("stage", ["resume", "module", "immediate"])
def test_stop_cancels_pending_startup(browser_audio_context, stage):
    result = run_async(
        browser_audio_context,
        """
        const stage = """
        + json.dumps(stage)
        + """;
        audioHarness.state = stage === 'resume' ? 'suspended' : 'running';
        audioHarness.worklet = stage === 'module';
        audioHarness.delayResume = stage === 'resume';
        audioHarness.delayModule = stage === 'module';
        const starting = player.play().then(() => 'resolved', error => error.name);
        player.stop();
        const outcome = await starting;
        if (stage === 'resume') audioHarness.resumes[0]();
        if (stage === 'module') audioHarness.modules[0]();
        for (let i = 0; i < 8; i++) await Promise.resolve();
        return {outcome, playing: player.isPlaying, connected: connectedNodes(),
            tracked: !!player.scriptNode || !!player.workletNode};
        """,
    )
    assert result == {
        "outcome": "AbortError",
        "playing": False,
        "connected": 0,
        "tracked": False,
    }


def test_cancelled_registration_can_be_reused_by_the_next_start(browser_audio_context):
    result = run_async(
        browser_audio_context,
        """
        audioHarness.worklet = audioHarness.delayModule = true;
        const first = player.play().then(() => 'resolved', error => error.name);
        player.stop();
        const second = player.play();
        audioHarness.modules[0]();
        const firstOutcome = await first;
        await second;
        const connected = connectedNodes(), worklet = player.useWorklet;
        player.stop();
        return {firstOutcome, connected, worklet, remaining: connectedNodes(),
            created: audioHarness.nodes.length, modules: audioHarness.moduleCalls,
            revoked: audioHarness.revoked, closed: audioHarness.nodes[0].closed};
        """,
    )
    assert result == {
        "firstOutcome": "AbortError",
        "connected": 1,
        "worklet": True,
        "remaining": 0,
        "created": 1,
        "modules": 1,
        "revoked": 1,
        "closed": True,
    }


@pytest.mark.parametrize("failure", ["resume", "module", "connect", "both"])
def test_audio_startup_failure_cleans_nodes_and_supports_fallback(
    browser_audio_context, failure
):
    result = run_async(
        browser_audio_context,
        """
        const failure = """
        + json.dumps(failure)
        + """;
        audioHarness.worklet = failure !== 'resume';
        audioHarness.state = failure === 'resume' ? 'suspended' : 'running';
        audioHarness.failResume = failure === 'resume';
        audioHarness.failModule = failure === 'module';
        audioHarness.failWorkletConnect = failure === 'connect' || failure === 'both';
        audioHarness.failScript = failure === 'both';
        const machine = player.machine;
        const outcome = await player.play().then(() => 'resolved', error => error.message);
        const connected = connectedNodes(), playing = player.isPlaying;
        const orphanWorklet = audioHarness.nodes.some(node => node.kind === 'worklet' &&
            (node.connected || !node.closed));
        player.stop();
        return {outcome, playing, connected, orphanWorklet, remaining: connectedNodes(),
            sameMachine: machine === player.machine};
        """,
    )
    expected_playing = failure in {"module", "connect"}
    assert result["playing"] == expected_playing
    assert result["connected"] == int(expected_playing)
    assert (result["outcome"] == "resolved") == expected_playing
    assert not result["orphanWorklet"]
    assert result["remaining"] == 0
    assert result["sameMachine"]


def test_worklet_ignores_old_callbacks_after_stop(browser_audio_context):
    result = run_async(
        browser_audio_context,
        """
        audioHarness.worklet = true;
        await player.play();
        const node = player.workletNode, callback = node.port.onmessage;
        const messages = node.messages, frames = player._frameCount;
        player.stop();
        callback({data: {type: 'needSamples'}});
        return {sameFrames: frames === player._frameCount, sameMessages: messages === node.messages,
            closed: node.closed, connected: connectedNodes(), handlerCleared: node.port.onmessage === null};
        """,
    )
    assert result == {
        "sameFrames": True,
        "sameMessages": True,
        "closed": True,
        "connected": 0,
        "handlerCleared": True,
    }


def test_worklet_startup_never_discards_requested_sample_blocks(browser_audio_context):
    result = run_async(
        browser_audio_context,
        """
        const AudioWorkletProcessor = class {
            constructor() { this.port = {}; }
        };
        let Processor;
        const registerProcessor = (name, implementation) => { Processor = implementation; };
        eval(sidWorkletProcessorCode);
        const requests = [], replies = [], counts = [0, 0, 0, 0, 0], order = [];
        let generated = 0, previous = 0;
        AudioWorkletNode = class extends MockAudioNode {
            constructor() {
                super('worklet');
                this.processor = new Processor();
                this.processor.port.postMessage = data => requests.push({node: this, data});
                this.port.postMessage = data => replies.push({node: this, data});
            }
            connect() {
                super.connect();
                this.render();
            }
            render() {
                const output = new Float32Array(128);
                this.processor.process([], [[output]], {});
                for (const sample of output) {
                    if (sample === 0) continue;
                    counts[sample]++;
                    if (sample !== previous) order.push(sample);
                    previous = sample;
                }
            }
        };
        audioHarness.worklet = true;
        player.generateSamples = output => output.fill(++generated);
        await player.play();
        const node = player.workletNode;
        // The audio thread can receive the initial block before the main thread
        // services a request emitted by its first empty render quantum.
        for (let quantum = 0; quantum < 256; quantum++) {
            while (replies.length) {
                const {node, data} = replies.shift();
                node.processor.port.onmessage({data});
            }
            node.render();
            if (requests.length && generated < 4) {
                const {node, data} = requests.shift();
                node.port.onmessage({data});
            }
        }
        player.stop();
        return {generated, counts: counts.slice(1), order};
        """,
    )
    assert result == {
        "generated": 4,
        "counts": [4096, 4096, 4096, 4096],
        "order": [1, 2, 3, 4],
    }


def test_script_callback_stops_cleanly_on_playback_failure(browser_audio_context):
    result = run_async(
        browser_audio_context,
        """
        await player.play();
        const callback = player.scriptNode.onaudioprocess;
        player.machine.runFrame = () => {player.machine.audioSamplesGenerated = 0;};
        const output = new Float32Array(32).fill(1);
        callback({outputBuffer: {getChannelData: () => output}});
        return {silent: output.every(value => value === 0), playing: player.isPlaying,
            connected: connectedNodes(), tracked: !!player.scriptNode};
        """,
    )
    assert result == {
        "silent": True,
        "playing": False,
        "connected": 0,
        "tracked": False,
    }


def test_play_without_a_tune_rejects(browser_audio_context):
    result = run_async(
        browser_audio_context,
        """
        const empty = new SIDPlayer();
        const outcome = await empty.play().then(() => 'resolved', error => error.message);
        return {outcome, playing: empty.isPlaying, contexts: audioHarness.contexts.length};
        """,
    )
    assert result == {
        "outcome": "No SID file is loaded",
        "playing": False,
        "contexts": 0,
    }


def test_newest_load_wins_when_fetches_finish_out_of_order(browser_audio_context):
    result = run_async(
        browser_audio_context,
        """
        const requests = {};
        globalThis.fetch = url => new Promise(resolve => {requests[url] = resolve;});
        const old = player.load('old').then(() => 'resolved', error => error.name);
        const latest = player.load('new');
        requests.new({ok: true, arrayBuffer: async () => makeSid({name: 'Newest'})});
        await latest;
        requests.old({ok: true, arrayBuffer: async () => makeSid({name: 'Stale'})});
        const outcome = await old;
        return {outcome, name: player.sidFile.name, playing: player.isPlaying};
        """,
    )
    assert result == {"outcome": "AbortError", "name": "Newest", "playing": False}


def test_direct_selection_supersedes_pending_fetch(browser_audio_context):
    result = run_async(
        browser_audio_context,
        """
        let complete;
        globalThis.fetch = () => new Promise(resolve => {complete = resolve;});
        const pending = player.load('old').then(() => 'resolved', error => error.name);
        player.loadData(makeSid({name: 'Direct'}));
        complete({ok: true, arrayBuffer: async () => makeSid({name: 'Stale'})});
        return {outcome: await pending, name: player.sidFile.name};
        """,
    )
    assert result == {"outcome": "AbortError", "name": "Direct"}


def test_superseded_network_failure_is_cancellation(browser_audio_context):
    result = run_async(
        browser_audio_context,
        """
        let rejectFetch;
        globalThis.fetch = () => new Promise((resolve, reject) => {rejectFetch = reject;});
        const pending = player.load('old').then(() => 'resolved', error => error.name);
        player.loadData(makeSid({name: 'Current'}));
        rejectFetch(new Error('Late network failure'));
        return {outcome: await pending, name: player.sidFile.name};
        """,
    )
    assert result == {"outcome": "AbortError", "name": "Current"}


def test_failed_fetch_preserves_playback(browser_audio_context):
    result = run_async(
        browser_audio_context,
        """
        await player.play();
        const machine = player.machine;
        globalThis.fetch = async () => ({ok: false, statusText: 'Not Found'});
        const outcome = await player.load('missing').then(() => 'resolved', error => error.message);
        return {outcome, sameMachine: machine === player.machine,
            playing: player.isPlaying, connected: connectedNodes()};
        """,
    )
    assert result == {
        "outcome": "Failed to load: Not Found",
        "sameMachine": True,
        "playing": True,
        "connected": 1,
    }


def test_visualization_reads_hardware_without_changing_sid_bus(audio_context):
    result = eval_json(
        audio_context,
        """(() => {
            const player = new SIDPlayer();
            player.loadData(makeSid());
            player.machine.write(1, 0x30);
            player.machine.write(0xd41b, 0x55);
            player.machine.sid.voice[2].wave().osc3 = 0xa50;
            player.machine.sid.applyRegisterWrite(0, 0x77);
            const ttl = player.machine.sid.busValueTtl;
            const state = player.getState();
            return {osc3: state.registers[27], bus: player.machine.sid.busValue,
                sameTtl: ttl === player.machine.sid.busValueTtl};
        })()""",
    )
    assert result == {"osc3": 0xA5, "bus": 0x77, "sameTtl": True}


def test_sid_peek_preserves_bus_and_read_keeps_its_side_effects(audio_context):
    result = eval_json(
        audio_context,
        """(() => {
            const sid = new SID();
            sid.applyRegisterWrite(0, 0x77);
            sid.voice[2].wave().osc3 = 0xa50;
            sid.voice[2].envelope().env3 = 0x42;
            const ttl = sid.busValueTtl;
            const peeked = [0, 0x19, 0x1a, 0x1b, 0x1c].map(register => sid.peek(register));
            const preserved = sid.busValue === 0x77 && sid.busValueTtl === ttl;
            const read = sid.read(0x1b);
            return {peeked, preserved, read, busAfterRead: sid.busValue};
        })()""",
    )
    assert result == {
        "peeked": [0x77, 255, 255, 0xA5, 0x42],
        "preserved": True,
        "read": 0xA5,
        "busAfterRead": 0xA5,
    }


@pytest.mark.parametrize(
    "module,check",
    [
        (test_sid_load, test_sid_load.test_sid_parsing),
        (test_sid_load, test_sid_load.test_player_initialization),
        (test_sid_load, test_sid_load.test_audio_generation),
        (test_sid_load, test_sid_load.test_giana_sisters_track1),
        (test_sid_load, test_sid_load.test_multi_track),
        (test_giana_timer, test_giana_timer.test_giana_timer_setup),
        (test_giana_timer, test_giana_timer.test_giana_irq_count),
    ],
    ids=lambda value: value.__name__,
)
def test_diagnostic_cases_fail_when_sid_fixtures_are_missing(
    monkeypatch, module, check
):
    missing = Path(__file__).parent / "_missing_audio_regression_fixtures_"
    assert not missing.exists()
    monkeypatch.setattr(module, "SID_DIR", missing)
    with pytest.raises(AssertionError, match="SID fixture"):
        check()
