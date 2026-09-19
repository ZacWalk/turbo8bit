"""Verify browser-wrapper boot/load contracts against the actual C64 machine."""

import re

import pytest

from tests.test_utils import (
    PROJECT_ROOT,
    create_crt_context,
    load_js_file,
    load_js_modules,
    strip_es6_imports_exports,
)


@pytest.fixture
def lab():
    ctx = create_crt_context()
    ctx.eval(
        """
        var document = {
            getElementById() {
                return { getContext() { return {}; } };
            }
        };
        var requestAnimationFrame = () => 1;
        var cancelAnimationFrame = () => {};
        performance.now = () => 0;
        """
    )
    load_js_modules(ctx, ["emulator.js"])
    ctx.eval(
        """
        var emulator = new C64Emulator('screen', { audioEnabled: false });
        function bootUntilReady() {
            let frames = 0;
            while (!emulator.basicReady && frames < 1000) {
                emulator.machine.runFrame();
                emulator.frame++;
                emulator.checkBasicReady();
                frames++;
            }
            return frames;
        }
        """
    )
    return ctx


@pytest.fixture
def lab_document(lab):
    ctx = lab
    ctx.eval(
        """
        var elements = new Map();
        document.getElementById = function(id) {
            if (!elements.has(id)) elements.set(id, {
                value: '', textContent: '',
                classList: { add() {}, remove() {}, toggle() {} },
                getContext() { return {}; },
                addEventListener() {},
                setAttribute() {},
                focus() {}
            });
            return elements.get(id);
        };
        document.addEventListener = () => {};
        document.querySelector = selector => document.getElementById(selector);
        var setTimeout = () => 1;
        var clearTimeout = () => {};
        var alert = message => { throw new Error(message); };
        var BASIC_START = 0x0801;
        var CodeEditor = class {
            constructor() { this.value = ''; }
            getValue() { return this.value; }
            setValue(value) { this.value = value; }
            setHighlightErrors() {}
            clearHighlight() {}
            highlightLine() {}
        };
        var ExampleLibrary = class {
            async populate() {}
            get(id) { return { direct: id === 'direct' }; }
            async select(id) {
                return { example: this.get(id), source: id === 'direct' ? 'PRINT 1' : '10 END' };
            }
        };
        """
    )
    return ctx


def load_lab_page(ctx, filename):
    template = load_js_file(PROJECT_ROOT / "web" / "templates" / filename)
    script = re.search(r'<script type="module">\s*(.*?)</script>', template, re.DOTALL)
    assert script is not None
    ctx.eval(strip_es6_imports_exports(script.group(1)))


@pytest.fixture
def basic_page(lab_document):
    ctx = lab_document
    load_lab_page(ctx, "index.html")
    ctx.eval(
        """
        var program = new Uint8Array([1, 8, 7, 8, 10, 0, 0x80, 0, 0, 0]);
        var compiled = { bytes: program, errors: [] };
        """
    )
    return ctx


@pytest.fixture
def asm_page(lab_document):
    ctx = lab_document
    load_js_modules(ctx, ["assembler.js", "debugger.js"])
    load_lab_page(ctx, "asm.html")
    ctx.eval("bootUntilReady(); emulator.pause(); emulator.machine.cpu.P |= 4;")
    return ctx


def test_prg_dropped_during_startup_is_loaded_after_ram_initialization(lab):
    ctx = lab
    ctx.eval(
        """
        var loaded = false;
        var program = new Uint8Array([1, 8, 7, 8, 10, 0, 0x80, 0, 0, 0]);
        emulator.loadPrgFile(program).then(() => { loaded = true; });
        """
    )
    assert not ctx.eval("loaded")
    assert ctx.eval("bootUntilReady()") < 1000
    assert ctx.eval("loaded && emulator.basicReady")
    assert ctx.eval("emulator.machine.peek(0x0805)") == 0x80
    assert ctx.eval("emulator.machine.peek(0x0801)") == 7


def test_return_to_basic_recovers_from_halt_banking_and_interrupt_changes(lab):
    ctx = lab
    ctx.eval("bootUntilReady();")
    ctx.eval(
        """
        emulator.machine.write(0xd01a, 1);
        emulator.machine.write(0xdc0d, 0x81);
        emulator.machine.write(0xdd0d, 0x82);
        emulator.machine.ram[0x0314] = 0xff;
        emulator.machine.ram[0x0315] = 0xff;
        emulator.machine.write(1, 0x30);
        emulator.machine.cpu.halted = true;
        emulator.pause();
        var returned = false;
        emulator.resetToBasic().then(() => { returned = true; });
        """
    )
    assert not ctx.eval("emulator.paused")
    assert not ctx.eval("emulator.machine.cpu.halted")
    assert ctx.eval("bootUntilReady()") < 1000
    assert ctx.eval("returned && emulator.basicReady")


def test_numbered_editor_run_always_loads_into_a_fresh_ready_machine(basic_page):
    ctx = basic_page
    ctx.eval(
        """
        bootUntilReady();
        emulator.machine.ram[0xc000] = 0xaa;
        var generation = emulator.bootGeneration;
        var loaded = false;
        loadBasicProgram(compiled).then(() => { loaded = true; });
        """
    )
    assert not ctx.eval("loaded || emulator.basicReady")
    assert ctx.eval("emulator.bootGeneration") == ctx.eval("generation + 1")
    ctx.eval("bootUntilReady();")
    assert ctx.eval("loaded")
    assert ctx.eval("emulator.machine.peek(0x0805)") == 0x80
    assert ctx.eval("emulator.machine.ram[0xc000]") == 0


def test_direct_editor_commands_preserve_existing_machine_state(basic_page):
    ctx = basic_page
    ctx.eval(
        """
        bootUntilReady();
        document.getElementById('sampleSelect').value = 'direct';
        loadSelectedSample();
        """
    )
    ctx.eval(
        """
        editor.setValue('POKE 49152,7');
        emulator.machine.ram[0xc000] = 0x55;
        var generation = emulator.bootGeneration;
        loadBasicProgram({ bytes: [], errors: [{ type: 'error' }] });
        """
    )
    assert ctx.eval("emulator.bootGeneration") == ctx.eval("generation")
    assert ctx.eval("emulator.machine.ram[0xc000]") == 0x55
    assert (
        ctx.eval("String.fromCharCode(...emulator.typingQueue.map(item => item.code))")
        == "POKE 49152,7\r"
    )


def test_screen_run_preserves_the_loaded_machine(basic_page):
    ctx = basic_page
    ctx.eval(
        """
        bootUntilReady();
        emulator.machine.ram[0xc000] = 0x77;
        var generation = emulator.bootGeneration;
        window.typeCommand('RUN\\n');
        """
    )
    assert ctx.eval("emulator.bootGeneration") == ctx.eval("generation")
    assert ctx.eval("emulator.machine.ram[0xc000]") == 0x77
    assert (
        ctx.eval("String.fromCharCode(...emulator.typingQueue.map(item => item.code))")
        == "RUN\r"
    )


def test_reset_cancels_a_numbered_program_waiting_for_startup(basic_page):
    ctx = basic_page
    ctx.eval(
        """
        loadBasicProgram(compiled);
        window.resetEmulator();
        bootUntilReady();
        """
    )
    assert ctx.eval("emulator.basicReady")
    assert ctx.eval("emulator.machine.peek(0x0801)") == 0
    assert ctx.eval("emulator.typingQueue.length") == 0


def test_slow_sample_response_preserves_edits_made_while_loading(basic_page):
    ctx = basic_page
    ctx.eval(
        """
        var finishSample;
        examples.select = () => new Promise(resolve => { finishSample = resolve; });
        document.getElementById('sampleSelect').value = 'direct';
        loadSelectedSample();
        editor.setValue('10 PRINT "MY EDITS"');
        finishSample({ example: { direct: true }, source: 'PRINT "OLD SAMPLE"' });
        """
    )
    assert ctx.eval("editor.getValue()") == '10 PRINT "MY EDITS"'
    assert ctx.eval("document.getElementById('sampleSelect').value") == "helloWorld"
    assert "kept" in ctx.eval("document.getElementById('emulator-status').textContent")


def test_slow_initial_sample_index_preserves_custom_source(basic_page):
    ctx = basic_page
    ctx.eval(
        """
        var finishIndex;
        examples.populate = () => new Promise(resolve => { finishIndex = resolve; });
        editor.setValue('');
        initExamples();
        editor.setValue('10 PRINT "CUSTOM"');
        finishIndex();
        """
    )
    assert ctx.eval("editor.getValue()") == '10 PRINT "CUSTOM"'
    assert ctx.eval("document.getElementById('sampleSelect').value") == ""


def test_assembly_stack_changes_do_not_resume_execution(asm_page):
    ctx = asm_page
    ctx.eval(
        """
        editor.setValue('ORG $C000\\nTSX\\nINX\\nINX\\nTXS\\nNOP');
        debuggerStep();
        """
    )
    ctx.eval("for (let i = 0; i < 4; i++) debuggerStep();")
    assert ctx.eval("emulator.machine.cpu.PC") == 0xC004
    assert ctx.eval("emulator.paused")


def test_assembly_top_level_rts_resumes_without_reset(asm_page):
    ctx = asm_page
    ctx.eval(
        """
        editor.setValue('ORG $C000\\nLDA #2\\nSTA $D020\\nRTS');
        var generation = emulator.bootGeneration;
        debuggerStep();
        """
    )
    ctx.eval("for (let i = 0; i < 3; i++) debuggerStep();")
    assert not ctx.eval("emulator.paused")
    assert ctx.eval("emulator.bootGeneration") == ctx.eval("generation")
    assert ctx.eval("emulator.machine.peek(0xd020) & 15") == 2


def test_external_machine_reset_clears_assembly_debug_state(asm_page):
    ctx = asm_page
    ctx.eval("editor.setValue('ORG $C000\\nNOP\\nRTS'); debuggerStep();")
    assert ctx.eval("debugger_.codeBytes !== null && isDebugMode")
    ctx.eval("emulator.reset();")
    assert ctx.eval("debugger_.codeBytes === null && currentSourceMap === null")
    assert not ctx.eval("isDebugMode || emulator.paused")
