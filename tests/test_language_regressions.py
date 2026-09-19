"""Regression coverage for program generation, editing, and debugger returns."""

import json
import re

import pytest

from tests.test_utils import (
    JS_DIR,
    STATIC_DIR,
    create_c64_context,
    create_mini_racer_context,
    eval_json,
    load_js_modules,
    strip_es6_imports_exports,
)


@pytest.fixture(scope="module")
def language_context():
    ctx = create_mini_racer_context()
    load_js_modules(ctx, ["assembler.js", "basic-tokenizer.js", "debugger.js"])
    editor = (JS_DIR / "editor.js").read_text(encoding="utf-8")
    editor = re.sub(r"(?ms)^import\s+.*?;\s*", "", editor)
    ctx.eval(strip_es6_imports_exports(editor))
    return ctx


@pytest.fixture(scope="module")
def machine_context():
    ctx = create_c64_context()
    load_js_modules(ctx, ["assembler.js", "basic-tokenizer.js", "debugger.js"])
    ctx.eval(
        r"""
        function languageTestBoot() {
            const machine = new C64Machine();
            for (let i = 0; i < 150; i++) machine.runFrame();
            return machine;
        }
        function languageTestType(machine, source) {
            for (const ch of source) {
                machine.addKey(ch.charCodeAt(0));
                for (let i = 0; i < 3; i++) machine.runFrame();
            }
        }
        function languageTestScreen(machine) {
            return Array.from(machine.ram.slice(0x0400, 0x07E8))
                .map(code => {
                    code &= 0x7F;
                    return String.fromCharCode(
                        code >= 1 && code <= 26 ? code + 64 : code
                    );
                }).join('');
        }
        """
    )
    return ctx


def assemble(ctx, source):
    return eval_json(
        ctx,
        f"""(() => {{
            const result = new Assembler().assemble({json.dumps(source)});
            return {{
                ...result,
                bytes: Array.from(result.bytes)
            }};
        }})()""",
    )


@pytest.mark.parametrize(
    ("source", "start", "expected"),
    [
        ("SCREEN = $0400\nORG $C000\nRTS", 0xC000, [0x60]),
        ("SCREEN: EQU $0400\nORG $C000\nLDA SCREEN", 0xC000, [0xAD, 0, 4]),
        ("ORG $0000\nNOP", 0, [0xEA]),
        ("ORG $1000\nORG $1010\nRTS", 0x1010, [0x60]),
        ("ORG $1010\nORG $1000\nRTS", 0x1000, [0x60]),
        ("ORG $1000\nBYTE $11\nORG $1003\nBYTE $22", 0x1000, [0x11, 0, 0, 0x22]),
    ],
)
def test_assembly_origin_matches_emitted_addresses(
    language_context, source, start, expected
):
    result = assemble(language_context, source)
    assert result["success"], result["errors"]
    assert result["startAddress"] == start
    assert result["bytes"] == expected
    assert [entry["address"] for entry in result["sourceMap"]] == list(
        range(start, start + len(expected))
    )


@pytest.mark.parametrize(
    ("data", "address", "expected"),
    [
        ("<TARGET", 0x0801, [1, 0x60]),
        ("<TARGET,>TARGET", 0x0802, [2, 8, 0x60]),
        ("$AA,<TARGET,$BB", 0x0803, [0xAA, 3, 0xBB, 0x60]),
    ],
)
def test_forward_byte_references_reserve_space(
    language_context, data, address, expected
):
    result = assemble(language_context, f"ORG $0800\nBYTE {data}\nTARGET:\nRTS")
    assert result["success"], result["errors"]
    assert result["symbols"]["TARGET"] == address
    assert result["bytes"] == expected


@pytest.mark.parametrize("operand", ["MISSING", "$01,MISSING,$02", "$GG", "$01,"])
def test_invalid_byte_data_is_not_silently_dropped(language_context, operand):
    result = assemble(language_context, f"ORG $0800\nBYTE {operand}\nRTS")
    assert not result["success"]
    assert any(error["lineNum"] == 2 for error in result["errors"])


@pytest.mark.parametrize(
    "source",
    [
        "ORG $1000\nBYTE 1\nORG $0FFF\nBYTE 2",
        "ORG $10000\nNOP",
        "ORG $GG\nNOP",
        "ORG $FFFF\nWORD $1234",
    ],
)
def test_invalid_assembly_layout_is_rejected(language_context, source):
    result = assemble(language_context, source)
    assert not result["success"]
    assert result["errors"]


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("10 PRINT1", [0x99, 0x31]),
        ("10 FORI=1TO3:NEXTI", [0x81, 73, 0xB2, 49, 0xA4, 51, 58, 0x82, 73]),
        ("10 ?1", [0x99, 0x31]),
        ("10 DATA1,PRINT,?:?2", [0x83, *b"1,PRINT,?:", 0x99, 50]),
        ('10 ?"PRINT1?":REMFORI', [0x99, *b'"PRINT1?":', 0x8F, *b"FORI"]),
    ],
)
def test_compact_basic_tokens(language_context, source, expected):
    result = eval_json(
        language_context,
        f"""(() => {{
            const result = new BASICTokenizer().tokenize({json.dumps(source)});
            return {{
                errors: result.errors,
                tokens: Array.from(result.lines[0].tokens)
            }};
        }})()""",
    )
    assert result["errors"] == []
    assert result["tokens"] == expected


def test_compact_basic_highlighting_matches_keywords(language_context):
    source = "10 FORI=1TO3:PRINTI;:NEXTI"
    tokens = eval_json(language_context, f"highlightBasic({json.dumps(source)})")
    assert "".join(token["text"] for token in tokens) == source
    assert [token["text"] for token in tokens if token["type"] == "keyword"] == [
        "FOR",
        "TO",
        "PRINT",
        "NEXT",
    ]


@pytest.mark.parametrize("source", ["NOT BASIC", "20 END\n10 END", ""])
def test_example_assertions_reject_invalid_programs(language_context, source):
    from tests.test_examples import TestBasicExamples

    examples = {"invalid": {"title": "Invalid control", "code": source}}
    language_context.eval(f"var EXAMPLES_BASIC = {json.dumps(examples)};")
    with pytest.raises(AssertionError):
        TestBasicExamples().test_all_basic_examples(language_context)


@pytest.mark.parametrize(
    ("source", "output"),
    [
        ("10 PRINT1", r"\b1\b"),
        ("10 FORI=1TO3:PRINTI;:NEXTI", r"\b1\s+2\s+3\b"),
        ("10 ?42", r"\b42\b"),
    ],
)
def test_compact_basic_runs_in_rom(machine_context, source, output):
    result = eval_json(
        machine_context,
        rf"""(() => {{
            const machine = languageTestBoot();
            const result = new BASICTokenizer().tokenize({json.dumps(source)});
            machine.ram.set(result.bytes.subarray(2), 0x0801);
            const end = 0x0801 + result.bytes.length - 2;
            for (const address of [0x2D, 0x2F, 0x31]) {{
                machine.ram[address] = end & 0xFF;
                machine.ram[address + 1] = end >> 8;
            }}
            languageTestType(machine, 'RUN\r');
            for (let i = 0; i < 50; i++) machine.runFrame();
            return {{errors: result.errors, screen: languageTestScreen(machine)}};
        }})()""",
    )
    assert result["errors"] == []
    assert "ERROR" not in result["screen"], result["screen"]
    assert re.search(output, result["screen"]), result["screen"]


def test_direct_examples_execute_as_commands(machine_context):
    manifest = json.loads((STATIC_DIR / "basic" / "index.json").read_text())
    examples = [example for example in manifest["examples"] if example.get("direct")]
    assert examples, "The direct-mode example must retain execution coverage"
    for example in examples:
        source = (STATIC_DIR / "basic" / example["file"]).read_text(encoding="utf-8")
        commands = (
            "\r".join(line for line in source.splitlines() if line.strip()) + "\r"
        )
        screen = eval_json(
            machine_context,
            f"""(() => {{
                const machine = languageTestBoot();
                languageTestType(machine, {json.dumps(commands)});
                for (let i = 0; i < 50; i++) machine.runFrame();
                return languageTestScreen(machine);
            }})()""",
        )
        assert "ERROR" not in screen, (example["id"], screen)
        if example["id"] == "directModeCalc":
            assert "65536" in screen
            assert "CELSIUS" in screen


@pytest.mark.parametrize(
    ("opcode", "sp_before", "sp_after", "entry_sp", "expected"),
    [
        (0x60, 0xFD, 0xFF, 0xFD, True),
        (0x60, 0, 2, 0, True),
        (0x60, 0xFF, 1, 0xFF, True),
        (0x9A, 0xFD, 0xFF, 0xFD, False),
        (0x4C, 0xFD, 0xFF, 0xFD, False),
        (0x40, 0xFD, 0xFF, 0xFD, False),
        (0x60, 0xFB, 0xFD, 0xFD, False),
        (0x60, 0xFD, 0xFA, 0xFD, False),
        (0x60, 0xFD, 0xFD, 0xFD, False),
        (0x60, 0xFD, 0xFF, None, False),
    ],
    ids=[
        "caller-return",
        "zero-entry-sp",
        "stack-wrap",
        "txs-is-not-return",
        "jmp-is-not-return",
        "rti-is-not-return",
        "nested-call",
        "interrupt-entry",
        "no-stack-pop",
        "no-program",
    ],
)
def test_top_level_rts_guard(
    language_context, opcode, sp_before, sp_after, entry_sp, expected
):
    arguments = json.dumps([opcode, sp_before, sp_after, entry_sp])
    assert language_context.eval(f"isTopLevelRTS(...{arguments})") is expected


def test_debugger_runs_rom_subroutines_until_top_level_return(machine_context):
    source = (STATIC_DIR / "assembly" / "print-character.asm").read_text()
    result = eval_json(
        machine_context,
        f"""(() => {{
            const machine = languageTestBoot();
            const returnPC = machine.cpu.PC;
            const returnSP = machine.cpu.SP;
            const stackedAddress = (returnPC - 1) & 0xFFFF;
            for (const byte of [stackedAddress >> 8, stackedAddress & 0xFF]) {{
                machine.write(0x0100 + machine.cpu.SP, byte);
                machine.cpu.SP = (machine.cpu.SP - 1) & 0xFF;
            }}
            const code = new Assembler().assemble({json.dumps(source)});
            const debuggerInstance = new C64Debugger(machine);
            debuggerInstance.loadCode(code.bytes, code.startAddress);
            let steps = 0;
            while (steps < 20000 && debuggerInstance.state !== DebuggerState.STOPPED) {{
                debuggerInstance.step();
                steps++;
            }}
            return {{
                state: debuggerInstance.state, steps, returnPC, returnSP,
                pc: machine.cpu.PC, sp: machine.cpu.SP,
                screen: languageTestScreen(machine)
            }};
        }})()""",
    )
    assert result["state"] == "stopped"
    assert 3 < result["steps"] < 20000
    assert result["pc"] == result["returnPC"]
    assert result["sp"] == result["returnSP"]
    assert "HI!" in result["screen"]


def test_debugger_interrupt_before_rts_is_not_a_return(language_context):
    result = eval_json(
        language_context,
        """(() => {
            const cpu = {
                PC: 0x0800, SP: 0xFD, P: 0, A: 0, X: 0, Y: 0, cycles: 0,
                step() {
                    this.SP -= 3;
                    this.PC = 0xFF48;
                    this.cycles += 7;
                }
            };
            const machine = {cpu, ram: new Uint8Array(65536), peek: () => 0x60};
            const debuggerInstance = new C64Debugger(machine);
            debuggerInstance.loadCode(new Uint8Array([0x60]), 0x0800);
            debuggerInstance.step();
            return {state: debuggerInstance.state, pc: cpu.PC};
        })()""",
    )
    assert result == {"state": "paused", "pc": 0xFF48}


def test_vertical_scroll_returns_keyboard_and_irq_to_basic(machine_context):
    source = (STATIC_DIR / "assembly" / "vertical-scrolling.asm").read_text()
    result = eval_json(
        machine_context,
        rf"""(() => {{
            const machine = languageTestBoot();
            const originalIRQ = machine.ram[0x0314] | (machine.ram[0x0315] << 8);
            const originalControl = machine.peek(0xD011) & 0x7F;
            const code = new Assembler().assemble({json.dumps(source)});
            if (!code.success) return {{errors: code.errors}};
            machine.ram.set(code.bytes, code.startAddress);
            languageTestType(machine, 'SYS2048\r');
            let frames = 0;
            while (frames < 1000 && machine.ram[code.symbols.DONE] !== 1) {{
                machine.runFrame();
                frames++;
            }}
            for (let i = 0; i < 25; i++) machine.runFrame();
            const columnBefore = machine.ram[0x00D3];
            const scrollBefore = machine.ram[code.symbols.YSCROLL];
            machine.setKey(1, 2, true);
            for (let i = 0; i < 5; i++) machine.runFrame();
            machine.setKey(1, 2, false);
            for (let i = 0; i < 2; i++) machine.runFrame();
            return {{
                done: machine.ram[code.symbols.DONE], frames, originalIRQ,
                originalControl, control: machine.peek(0xD011) & 0x7F,
                irq: machine.ram[0x0314] | (machine.ram[0x0315] << 8),
                rasterEnabled: machine.peek(0xD01A) & 1,
                columnBefore, columnAfter: machine.ram[0x00D3],
                scrollBefore, scrollAfter: machine.ram[code.symbols.YSCROLL]
            }};
        }})()""",
    )
    assert "errors" not in result, result
    assert result["done"] == 1
    assert result["frames"] < 1000
    assert result["irq"] == result["originalIRQ"]
    assert result["rasterEnabled"] == 0
    assert result["control"] == result["originalControl"]
    assert result["columnBefore"] == 0
    assert result["columnAfter"] == 1
    assert result["scrollAfter"] == result["scrollBefore"]


@pytest.fixture
def editor_context(language_context):
    language_context.eval(
        """
        var editorTestElements = {};
        function editorTestElement() {
            return {
                value: '', style: {}, handlers: {}, attributes: {},
                selectionStart: 0, selectionEnd: 0,
                classList: {add() {}, remove() {}},
                addEventListener(name, callback) { this.handlers[name] = callback; },
                setAttribute(name, value) { this.attributes[name] = value; },
                focus() { document.activeElement = this; }
            };
        }
        var document = {
            activeElement: null,
            commands: [],
            execCommand(command, showUI, text) {
                this.commands.push([command, showUI, text]);
                const textarea = this.activeElement;
                const start = textarea.selectionStart;
                textarea.value = textarea.value.slice(0, start) + text
                    + textarea.value.slice(textarea.selectionEnd);
                textarea.selectionStart = textarea.selectionEnd = start + text.length;
                textarea.handlers.input();
                return true;
            }
        };
        function editorTestCreate(language) {
            const container = editorTestElement();
            container.querySelector = selector => {
                if ((language === 'asm' && selector === '.load-btn')
                    || (language !== 'asm'
                        && ['.run-btn', '.step-btn', '.stop-btn'].includes(selector))) {
                    return null;
                }
                return editorTestElements[selector] ||= editorTestElement();
            };
            return new CodeEditor(container, {language});
        }
        """
    )
    return language_context


def test_editor_uses_native_editing_for_tab_and_paste(editor_context):
    result = eval_json(
        editor_context,
        """(() => {
            const editor = editorTestCreate('basic');
            editor.setValue('10 PRINT 1');
            const textarea = editor.textarea;
            textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
            let changes = 0, prevented = false;
            editor.options.onChange = () => changes++;
            textarea.handlers.keydown({
                key: 'Tab',
                preventDefault() { prevented = true; }
            });
            return {
                text: editor.getValue(), changes, prevented,
                commands: document.commands,
                customPasteHandler: !!textarea.handlers.paste
            };
        })()""",
    )
    assert result["text"] == "10 PRINT 1  "
    assert result["commands"] == [["insertText", False, "  "]]
    assert result["changes"] == 1
    assert result["prevented"]
    assert not result["customPasteHandler"]


@pytest.mark.parametrize("modifier", ["shiftKey", "ctrlKey", "altKey", "metaKey"])
def test_editor_modified_tab_keeps_native_navigation(editor_context, modifier):
    result = eval_json(
        editor_context,
        f"""(() => {{
            const editor = editorTestCreate('basic');
            let prevented = false;
            editor.textarea.handlers.keydown({{
                key: 'Tab', {modifier}: true,
                preventDefault() {{ prevented = true; }}
            }});
            return {{prevented, commands: document.commands}};
        }})()""",
    )
    assert not result["prevented"]
    assert result["commands"] == []


@pytest.mark.parametrize(
    ("language", "label"),
    [("basic", "BASIC code editor"), ("asm", "Assembly code editor")],
)
def test_editor_controls_have_accessible_names(editor_context, language, label):
    html = editor_context.eval(
        f"editorTestCreate({json.dumps(language)}).container.innerHTML"
    )
    assert f'aria-label="{label}"' in html
    assert 'aria-label="Search code"' in html
    assert 'aria-label="Find next"' in html
    for class_name in ["line-numbers", "editor-highlight"]:
        assert re.search(
            rf'<div\b[^>]*class="{class_name}"[^>]*aria-hidden="true"', html
        )


def test_editor_language_change_updates_accessible_name(editor_context):
    label = editor_context.eval(
        """(() => {
            const editor = editorTestCreate('basic');
            editor.setLanguage('asm');
            return editor.textarea.attributes['aria-label'];
        })()"""
    )
    assert label == "Assembly code editor"
