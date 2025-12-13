"""
Tests for verifying all assembly and BASIC examples can be assembled/tokenized.

This ensures that all code examples in the editor dropdowns are valid and work correctly.
"""

import json
from pathlib import Path

import pytest
from py_mini_racer import MiniRacer

from tests.test_utils import (
    JS_DIR,
    STATIC_DIR,
    load_js_file,
    strip_es6_with_async,
    create_mini_racer_context,
    MINIMAL_BROWSER_ENV,
)


def load_example_file(folder: str, filename: str) -> str:
    """Load an example file (.asm or .bas) from the static directory."""
    path = STATIC_DIR / folder / filename
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def load_examples_index(folder: str) -> dict:
    """Load the examples index.json from a folder."""
    path = STATIC_DIR / folder / "index.json"
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    # Build lookup by ID
    examples = {}
    for example in data['examples']:
        example_id = example['id']
        example['code'] = load_example_file(folder, example['file'])
        examples[example_id] = example
    return examples


def get_js_path(filename):
    """Get path to a JavaScript file in the emulator directory."""
    return JS_DIR / filename


def load_module(ctx, filename):
    """Load a JavaScript module, stripping ES6 import/export."""
    js_path = get_js_path(filename)
    code = js_path.read_text(encoding='utf-8')
    return strip_es6_with_async(code)


def assemble_code(ctx, code: str) -> dict:
    """Assemble 6502 assembly code and return the result.
    
    Args:
        ctx: MiniRacer context with assembler loaded
        code: Assembly source code string
        
    Returns:
        dict with keys: success, errors, bytes, byteCount, symbols
    """
    # Escape the code for JavaScript string
    escaped_code = json.dumps(code)
    result_json = ctx.eval(f"""
        (function() {{
            var asm = new Assembler();
            var result = asm.assemble({escaped_code});
            return JSON.stringify({{
                success: result.success,
                errors: result.errors.map(function(e) {{ 
                    return {{ lineNum: e.lineNum, message: e.message }}; 
                }}),
                bytes: Array.from(result.bytes),
                byteCount: result.bytes.length,
                symbols: result.symbols
            }});
        }})()
    """)
    return json.loads(result_json)


@pytest.fixture
def assembler_context():
    """Create a MiniRacer context with the assembler loaded."""
    ctx = create_mini_racer_context(MINIMAL_BROWSER_ENV)
    
    # Load assembler
    code = load_module(ctx, "assembler.js")
    ctx.eval(code)
    
    # Load examples from JSON index files
    examples = load_examples_index("assembly")
    ctx.eval(f"var EXAMPLES_ASM = {json.dumps(examples)};")
    
    return ctx


@pytest.fixture
def tokenizer_context():
    """Create a MiniRacer context with the BASIC tokenizer loaded."""
    from py_mini_racer import MiniRacer
    
    ctx = MiniRacer()
    
    # Set up minimal browser environment
    ctx.eval("""
        var window = {};
        var console = { 
            log: function() {}, 
            warn: function() {}, 
            error: function() {} 
        };
    """)
    
    # Load the BASIC tokenizer
    code = load_module(ctx, "basic-tokenizer.js")
    ctx.eval(code)
    
    # Load examples from JSON index files
    examples = load_examples_index("basic")
    ctx.eval(f"var EXAMPLES_BASIC = {json.dumps(examples)};")
    
    return ctx


class TestAssemblyExamples:
    """Test that all assembly examples can be assembled."""
    
    def test_assembler_exists(self, assembler_context):
        """Verify assembler class is loaded."""
        result = assembler_context.eval("typeof Assembler")
        assert result == "function", "Assembler class should be defined"
    
    def test_examples_exist(self, assembler_context):
        """Verify EXAMPLES_ASM is loaded and has examples."""
        result = assembler_context.eval("Object.keys(EXAMPLES_ASM).length")
        assert result > 0, "EXAMPLES_ASM should have examples"
    
    def test_get_example_names(self, assembler_context):
        """Get list of all assembly example names."""
        result = assembler_context.eval("JSON.stringify(Object.keys(EXAMPLES_ASM))")
        import json
        names = json.loads(result)
        assert len(names) > 0, "Should have assembly examples"
        print(f"Found {len(names)} assembly examples: {names}")
    
    def test_hello_example(self, assembler_context):
        """Test assembling the 'hello' example."""
        code = assembler_context.eval("EXAMPLES_ASM.hello.code")
        data = assemble_code(assembler_context, code)
        assert data['success'], f"hello example failed: {data['errors']}"
        assert data['byteCount'] > 0, "Should generate bytes"
    
    def test_loop_example(self, assembler_context):
        """Test assembling the 'loop' example."""
        code = assembler_context.eval("EXAMPLES_ASM.loop.code")
        data = assemble_code(assembler_context, code)
        assert data['success'], f"loop example failed: {data['errors']}"
    
    def test_raster_example(self, assembler_context):
        """Test assembling the 'raster' example with #<LABEL and #>LABEL."""
        code = assembler_context.eval("EXAMPLES_ASM.raster.code")
        data = assemble_code(assembler_context, code)
        assert data['success'], f"raster example failed: {data['errors']}"
    
    def test_scroll_example(self, assembler_context):
        """Test assembling the horizontal 'scroll' example."""
        code = assembler_context.eval("EXAMPLES_ASM.scroll.code")
        data = assemble_code(assembler_context, code)
        assert data['success'], f"scroll example failed: {data['errors']}"
    
    def test_vscroll_example(self, assembler_context):
        """Test assembling the 'vscroll' example with LABEL+n and indirect indexed."""
        code = assembler_context.eval("EXAMPLES_ASM.vscroll.code")
        data = assemble_code(assembler_context, code)
        assert data['success'], f"vscroll example failed: {data['errors']}"
        # Verify key symbols are defined
        assert 'LINEPTR' in data['symbols'], "LINEPTR should be defined"
        assert 'LINES' in data['symbols'], "LINES should be defined"
    
    def test_all_assembly_examples(self, assembler_context):
        """Test that ALL assembly examples assemble successfully."""
        result = assembler_context.eval("""
            (function() {
                var results = {};
                var names = Object.keys(EXAMPLES_ASM);
                for (var i = 0; i < names.length; i++) {
                    var name = names[i];
                    var asm = new Assembler();
                    var example = EXAMPLES_ASM[name];
                    var result = asm.assemble(example.code);
                    results[name] = {
                        title: example.title,
                        success: result.success,
                        errors: result.errors.map(function(e) { 
                            return 'Line ' + e.lineNum + ': ' + e.message; 
                        }),
                        byteCount: result.bytes.length
                    };
                }
                return JSON.stringify(results);
            })()
        """)
        import json
        data = json.loads(result)
        
        failed = []
        for name, info in data.items():
            if not info['success']:
                failed.append(f"{name} ({info['title']}): {info['errors']}")
        
        assert len(failed) == 0, f"Failed examples:\n" + "\n".join(failed)
        print(f"All {len(data)} assembly examples assembled successfully!")


class TestExpressionParsing:
    """Test expression parsing in the assembler."""
    
    def test_label_plus_offset(self, assembler_context):
        """Test LABEL+n syntax."""
        code = """
    ORG $0800
    LDA PTR
    STA PTR+1
    STA PTR+2
    RTS
PTR:
    BYTE $00,$00,$00
"""
        data = assemble_code(assembler_context, code)
        assert data['success'], f"LABEL+n failed: {data['errors']}"
    
    def test_label_minus_offset(self, assembler_context):
        """Test LABEL-n syntax."""
        code = """
    ORG $0800
END:
    LDA END-1
    RTS
"""
        data = assemble_code(assembler_context, code)
        assert data['success'], f"LABEL-n failed: {data['errors']}"
    
    def test_low_byte_operator(self, assembler_context):
        """Test #<LABEL syntax."""
        code = """
    ORG $0800
    LDA #<HANDLER
    STA $0314
    LDA #>HANDLER
    STA $0315
    RTS
HANDLER:
    RTI
"""
        data = assemble_code(assembler_context, code)
        assert data['success'], f"<LABEL failed: {data['errors']}"
        # HANDLER is at $080A (after ORG $0800 + 10 bytes)
        # LDA #<HANDLER should load $0A
        # LDA #>HANDLER should load $08
    
    def test_indirect_indexed_addressing(self, assembler_context):
        """Test (zp),Y addressing mode."""
        code = """
    ORG $0800
    LDY #$00
    LDA (PTR),Y
    STA (PTR),Y
    RTS
PTR = $FB
"""
        data = assemble_code(assembler_context, code)
        assert data['success'], f"(zp),Y failed: {data['errors']}"
        # LDA (PTR),Y opcode is $B1
        # STA (PTR),Y opcode is $91
        assert 0xB1 in data['bytes'], "Should contain LDA (zp),Y opcode"
        assert 0x91 in data['bytes'], "Should contain STA (zp),Y opcode"


class TestBasicExamples:
    """Test that all BASIC examples can be tokenized."""
    
    def test_tokenizer_exists(self, tokenizer_context):
        """Verify tokenizer class is loaded."""
        result = tokenizer_context.eval("typeof BASICTokenizer")
        assert result == "function", "BASICTokenizer class should be defined"
    
    def test_examples_exist(self, tokenizer_context):
        """Verify EXAMPLES_BASIC is loaded and has examples."""
        result = tokenizer_context.eval("Object.keys(EXAMPLES_BASIC).length")
        assert result > 0, "EXAMPLES_BASIC should have examples"
    
    def test_all_basic_examples(self, tokenizer_context):
        """Test that ALL BASIC examples tokenize successfully."""
        result = tokenizer_context.eval("""
            (function() {
                var results = {};
                var names = Object.keys(EXAMPLES_BASIC);
                for (var i = 0; i < names.length; i++) {
                    var name = names[i];
                    var tok = new BASICTokenizer();
                    var example = EXAMPLES_BASIC[name];
                    try {
                        var result = tok.tokenize(example.code);
                        results[name] = {
                            title: example.title,
                            success: true,
                            byteCount: result.length
                        };
                    } catch (e) {
                        results[name] = {
                            title: example.title,
                            success: false,
                            error: e.message
                        };
                    }
                }
                return JSON.stringify(results);
            })()
        """)
        import json
        data = json.loads(result)
        
        failed = []
        for name, info in data.items():
            if not info['success']:
                failed.append(f"{name} ({info['title']}): {info.get('error', 'Unknown error')}")
        
        assert len(failed) == 0, f"Failed examples:\n" + "\n".join(failed)
        print(f"All {len(data)} BASIC examples tokenized successfully!")
