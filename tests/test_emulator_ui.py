"""Regression tests for the browser wrapper, without a browser or audio device."""

import json
import re

import pytest

from tests.test_utils import (
    JS_DIR,
    create_mini_racer_context,
    load_js_file,
    strip_es6_imports_exports,
)


@pytest.fixture
def emulator_ui():
    ctx = create_mini_racer_context()
    ctx.eval(
        """
        var ChipModel = { MOS6581: 0 };
        var SamplingMethod = { DECIMATE: 0 };
        var C64Machine = class {
            constructor(options) {
                this.audioEnabled = options.audioEnabled;
                this.sampleRate = options.sampleRate;
                this.clockFrequency = 985248;
                this.sid = { setSamplingParameters() {} };
                this.keys = new Set();
                this.joystick = new Set();
                this.typed = [];
                this.audioSamplesGenerated = 0;
                this.ram = new Uint8Array(65536);
            }
            setKey(row, col, pressed) {
                const key = row + ',' + col;
                if (pressed) this.keys.add(key);
                else this.keys.delete(key);
            }
            setJoystickButton(port, button, pressed) {
                const key = port + ',' + button;
                if (pressed) this.joystick.add(key);
                else this.joystick.delete(key);
            }
            releaseAllKeys() { this.keys.clear(); }
            ejectCartridge() {}
            reset() { this.keys.clear(); this.ram.fill(0); }
            peek(address) { return this.ram[address & 0xffff]; }
            runFrame() {}
            addKey(code) { this.typed.push(code); }
        };
        var VICIIRenderer = class { render() {} };
        var canvas = {
            getContext() { return {}; },
            addEventListener() {},
            closest() { return null; }
        };
        var document = {
            getElementById() { return canvas; },
            addEventListener() {}
        };
        var audioContexts = [];
        window.AudioContext = class {
            constructor(options) {
                this.sampleRate = options.sampleRate;
                this.state = 'running';
                audioContexts.push(this);
            }
            createScriptProcessor() {
                return { connect() {}, disconnect() {} };
            }
            close() { this.state = 'closed'; return Promise.resolve(); }
            resume() { this.state = 'running'; return Promise.resolve(); }
        };
        var scheduledFrames = new Map();
        var scheduledTimers = new Map();
        var nextCallback = 0;
        var requestAnimationFrame = callback => {
            scheduledFrames.set(++nextCallback, callback);
            return nextCallback;
        };
        var cancelAnimationFrame = id => scheduledFrames.delete(id);
        var setTimeout = callback => {
            scheduledTimers.set(++nextCallback, callback);
            return nextCallback;
        };
        var clearTimeout = id => scheduledTimers.delete(id);
        performance.now = () => 0;
        function keyEvent(key, code, target = canvas) {
            return {
                key, code, target, defaultPrevented: false,
                preventDefault() { this.defaultPrevented = true; }
            };
        }
        function runTimers() {
            while (scheduledTimers.size) {
                const [id, callback] = scheduledTimers.entries().next().value;
                scheduledTimers.delete(id);
                callback();
            }
        }
        function markBasicReady() {
            emulator.machine.ram.set([1, 8, 3, 8], 0x2b);
            emulator.machine.ram.set([18, 5, 1, 4, 25, 46], 0x400);
        }
        """
    )
    source = re.sub(
        r"^import\s+[\s\S]*?from\s+['\"][^'\"]+['\"];",
        "",
        load_js_file(JS_DIR / "emulator.js"),
        flags=re.MULTILINE,
    )
    ctx.eval(strip_es6_imports_exports(source))
    ctx.eval("var emulator = new C64Emulator('screen', { audioEnabled: false });")
    return ctx


def test_unmute_allocates_and_feeds_audio_ring(emulator_ui):
    ctx = emulator_ui
    ctx.eval("emulator.enableAudio();")
    assert ctx.eval("emulator.audioEnabled && emulator.machine.audioEnabled")
    assert ctx.eval("emulator.audioRing instanceof Float32Array")
    assert ctx.eval("emulator.audioProcessor !== null")
    ctx.eval(
        """
        emulator.frameSamples.set([16384, -16384]);
        emulator.machine.audioSamplesGenerated = 2;
        emulator.pushFrameAudio();
        var output = new Float32Array(2);
        emulator.drainAudio(output);
        """
    )
    assert ctx.eval("output[0]") == 0.5
    assert ctx.eval("output[1]") == -0.5


def test_failed_audio_initialization_closes_context(emulator_ui):
    ctx = emulator_ui
    ctx.eval(
        """
        window.AudioContext.prototype.createScriptProcessor = function() {
            throw new Error('Audio device unavailable');
        };
        emulator.enableAudio();
        """
    )
    assert ctx.eval("!emulator.audioEnabled && !emulator.machine.audioEnabled")
    assert ctx.eval("audioContexts[0].state") == "closed"
    assert ctx.eval("emulator.audioContext === null")


def test_key_release_uses_physical_key_identity(emulator_ui):
    ctx = emulator_ui
    ctx.eval(
        """
        emulator.handleKeyPress(keyEvent('Shift', 'ShiftLeft'));
        emulator.handleKeyPress(keyEvent('A', 'KeyA'));
        emulator.frame++;
        emulator.handleKeyRelease(keyEvent('Shift', 'ShiftLeft'));
        emulator.handleKeyRelease(keyEvent('a', 'KeyA'));
        """
    )
    assert ctx.eval("emulator.heldKeys.size") == 0
    assert ctx.eval("emulator.machine.keys.size") == 0


def test_releasing_one_shift_keeps_other_shift_down(emulator_ui):
    ctx = emulator_ui
    ctx.eval(
        """
        emulator.handleKeyPress(keyEvent('Shift', 'ShiftLeft'));
        emulator.handleKeyPress(keyEvent('Shift', 'ShiftRight'));
        emulator.handleKeyRelease(keyEvent('Shift', 'ShiftLeft'));
        """
    )
    assert ctx.eval("emulator.machine.keys.has('1,7')")


@pytest.mark.parametrize("tag", ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"])
def test_native_controls_keep_their_keyboard_events(emulator_ui, tag):
    ctx = emulator_ui
    ctx.eval(
        f"""
        var control = {{ tagName: '{tag}', closest() {{ return this; }} }};
        var event = keyEvent('a', 'KeyA', control);
        emulator.handleKeyPress(event);
        """
    )
    assert not ctx.eval("event.defaultPrevented")
    assert ctx.eval("emulator.machine.keys.size") == 0


def test_deferred_release_does_not_lift_a_repressed_key(emulator_ui):
    ctx = emulator_ui
    ctx.eval(
        """
        emulator.handleKeyPress(keyEvent('a', 'KeyA'));
        emulator.handleKeyRelease(keyEvent('a', 'KeyA'));
        emulator.handleKeyPress(keyEvent('a', 'KeyA'));
        emulator.running = true;
        emulator.lastTime = -25;
        emulator.loop();
        """
    )
    assert ctx.eval("emulator.machine.keys.has('1,2')")


def test_shared_matrix_position_stays_down_until_both_keys_release(emulator_ui):
    ctx = emulator_ui
    ctx.eval(
        """
        emulator.handleKeyPress(keyEvent('Backspace', 'Backspace'));
        emulator.handleKeyPress(keyEvent('Delete', 'Delete'));
        emulator.frame++;
        emulator.handleKeyRelease(keyEvent('Backspace', 'Backspace'));
        """
    )
    assert ctx.eval("emulator.machine.keys.has('0,0')")


def test_stop_cancels_animation_before_restart(emulator_ui):
    ctx = emulator_ui
    ctx.eval("emulator.start(); emulator.stop(); emulator.start();")
    assert ctx.eval("scheduledFrames.size") == 1


def test_reset_resumes_and_clears_pending_input_and_audio(emulator_ui):
    ctx = emulator_ui
    ctx.eval(
        """
        emulator.handleKeyPress(keyEvent('a', 'KeyA'));
        emulator.typeText('OLD');
        emulator.pause();
        emulator.ringWrite = 128;
        emulator.lastSample = 0.5;
        emulator.reset();
        runTimers();
        """
    )
    assert not ctx.eval("emulator.paused")
    assert ctx.eval("emulator.heldKeys.size") == 0
    assert ctx.eval("emulator.machine.typed.length") == 0
    assert ctx.eval("emulator.ringWrite - emulator.ringRead") == 0
    assert ctx.eval("emulator.lastSample") == 0


def test_synthetic_typing_is_serialized(emulator_ui):
    ctx = emulator_ui
    ctx.eval("emulator.typeText('AB'); emulator.typeText('CD');")
    assert ctx.eval("scheduledTimers.size") == 1
    ctx.eval("runTimers();")
    assert ctx.eval("String.fromCharCode(...emulator.machine.typed)") == "ABCD"


def test_short_joystick_press_is_visible_for_a_frame(emulator_ui):
    ctx = emulator_ui
    ctx.eval(
        """
        emulator.setActiveJoystick(2);
        emulator.handleKeyPress(keyEvent('ArrowUp', 'ArrowUp'));
        emulator.handleKeyRelease(keyEvent('ArrowUp', 'ArrowUp'));
        """
    )
    assert ctx.eval("emulator.machine.joystick.has('2,up')")
    ctx.eval(
        """
        emulator.running = true;
        emulator.lastTime = -25;
        emulator.loop();
        """
    )
    assert not ctx.eval("emulator.machine.joystick.has('2,up')")


def test_joystick_mode_does_not_swallow_button_keyup(emulator_ui):
    ctx = emulator_ui
    ctx.eval(
        """
        emulator.setActiveJoystick(2);
        var control = { closest() { return this; } };
        var down = keyEvent(' ', 'Space', control);
        var up = keyEvent(' ', 'Space', control);
        emulator.handleKeyPress(down);
        emulator.handleKeyRelease(up);
        """
    )
    assert not ctx.eval("down.defaultPrevented || up.defaultPrevented")
    assert ctx.eval("emulator.machine.joystick.size") == 0


@pytest.mark.parametrize(
    ("key", "code", "shifted"),
    [("*", "Digit8", False), ('"', "Quote", True), ("'", "Quote", True)],
)
def test_c64_punctuation_shift_is_preserved_through_a_short_press(
    emulator_ui, key, code, shifted
):
    ctx = emulator_ui
    ctx.eval(
        f"""
        emulator.handleKeyPress(keyEvent('Shift', 'ShiftLeft'));
        emulator.handleKeyPress(keyEvent({json.dumps(key)}, {json.dumps(code)}));
        emulator.handleKeyRelease(keyEvent({json.dumps(key)}, {json.dumps(code)}));
        emulator.handleKeyRelease(keyEvent('Shift', 'ShiftLeft'));
        """
    )
    assert ctx.eval("emulator.machine.keys.has('1,7')") == shifted
    ctx.eval(
        """
        emulator.running = true;
        emulator.lastTime = -25;
        emulator.loop();
        """
    )
    assert ctx.eval("emulator.machine.keys.size") == 0


def test_basic_loading_waits_for_a_real_fresh_boot_prompt(emulator_ui):
    ctx = emulator_ui
    ctx.eval(
        """
        var ready = false;
        emulator.whenBasicReady().then(() => { ready = true; });
        emulator.checkBasicReady();
        """
    )
    assert not ctx.eval("ready")
    ctx.eval(
        """
        emulator.machine.ram.set([18, 5, 1, 4, 25, 46], 0x400);
        emulator.checkBasicReady();
        """
    )
    assert not ctx.eval("ready")
    ctx.eval("markBasicReady(); emulator.checkBasicReady();")
    assert ctx.eval("ready && emulator.basicReady")


def test_reset_invalidates_pending_basic_loads(emulator_ui):
    ctx = emulator_ui
    ctx.eval(
        """
        var oldReady = false;
        var cancelled = false;
        emulator.whenBasicReady().then(
            () => { oldReady = true; },
            () => { cancelled = true; }
        );
        emulator.reset();
        var newReady = false;
        emulator.whenBasicReady().then(() => { newReady = true; });
        markBasicReady();
        emulator.checkBasicReady();
        """
    )
    assert ctx.eval("cancelled && !oldReady && newReady")


def test_basic_readiness_is_latched_until_reset(emulator_ui):
    ctx = emulator_ui
    ctx.eval(
        """
        markBasicReady();
        emulator.checkBasicReady();
        emulator.machine.ram.fill(0);
        var ready = false;
        emulator.whenBasicReady().then(() => { ready = true; });
        """
    )
    assert ctx.eval("ready")
    ctx.eval("emulator.reset();")
    assert not ctx.eval("emulator.basicReady")


def test_boot_watchdog_reports_failure_instead_of_forcing_readiness(emulator_ui):
    ctx = emulator_ui
    ctx.eval(
        """
        var bootError;
        emulator.whenBasicReady().catch(error => { bootError = error.message; });
        for (let i = 0; i <= 1000; i++) emulator.checkBasicReady();
        """
    )
    assert not ctx.eval("emulator.basicReady")
    assert "did not reach BASIC READY" in ctx.eval("bootError")


def test_cancelled_audio_start_cannot_close_a_newer_audio_graph(emulator_ui):
    ctx = emulator_ui
    ctx.eval(
        """
        var resumes = [];
        var MockAudioContext = window.AudioContext;
        window.AudioContext = class extends MockAudioContext {
            constructor(options) {
                super(options);
                this.state = 'suspended';
            }
            resume() {
                return new Promise((resolve, reject) => resumes.push({
                    resolve: () => { this.state = 'running'; resolve(); },
                    reject
                }));
            }
        };
        emulator.audioEnabled = true;
        emulator.machine.audioEnabled = true;
        emulator.start();
        emulator.stop();
        emulator.start();
        resumes[0].reject(new Error('Old context was closed'));
        """
    )
    ctx.eval("resumes[1].resolve();")
    assert ctx.eval("emulator.audioContext === audioContexts[1]")
    assert ctx.eval("emulator.audioEnabled && emulator.machine.audioEnabled")
    assert ctx.eval("audioContexts[0].state") == "closed"
    assert ctx.eval("scheduledFrames.size") == 1
