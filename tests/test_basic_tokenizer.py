"""
Test BASIC Tokenizer - Verify BASIC tokenization works correctly

This tests the BASIC tokenizer JavaScript module using py_mini_racer.
"""

import pytest
from py_mini_racer import MiniRacer

from tests.test_utils import (
    JS_DIR,
    load_js_file,
    strip_es6_imports_exports,
    create_mini_racer_context,
    MINIMAL_BROWSER_ENV,
)


def load_module(ctx, filename):
    """Load a JavaScript module, stripping ES6 import/export."""
    js_path = JS_DIR / filename
    code = js_path.read_text(encoding='utf-8')
    return strip_es6_imports_exports(code)


@pytest.fixture
def tokenizer_ctx():
    """Create a MiniRacer context with the BASIC tokenizer loaded."""
    ctx = create_mini_racer_context(MINIMAL_BROWSER_ENV)
    
    # Load the tokenizer module
    tokenizer_code = load_module(ctx, 'basic-tokenizer.js')
    ctx.eval(tokenizer_code)
    
    return ctx


class TestBASICTokenizer:
    """Tests for the BASIC tokenizer."""
    
    def test_tokenizer_exists(self, tokenizer_ctx):
        """Test that the BASICTokenizer class exists."""
        result = tokenizer_ctx.eval('typeof BASICTokenizer')
        assert result == 'function', 'BASICTokenizer should be a constructor function'
    
    def test_create_tokenizer(self, tokenizer_ctx):
        """Test creating a tokenizer instance."""
        tokenizer_ctx.eval('var tokenizer = new BASICTokenizer()')
        result = tokenizer_ctx.eval('tokenizer !== null')
        assert result is True
    
    def test_tokenize_hello_world(self, tokenizer_ctx):
        """Test tokenizing a simple Hello World program."""
        tokenizer_ctx.eval('var tokenizer = new BASICTokenizer()')
        tokenizer_ctx.eval('var result = tokenizer.tokenize(\'10 PRINT "HELLO WORLD"\')')
        error_count = tokenizer_ctx.eval('result.errors.length')
        line_count = tokenizer_ctx.eval('result.lines.length')
        byte_length = tokenizer_ctx.eval('result.bytes.length')
        
        assert error_count == 0, 'Should have no errors'
        assert line_count == 1, 'Should have 1 line'
        assert byte_length > 0, 'Should produce bytes'
    
    def test_prg_header(self, tokenizer_ctx):
        """Test that tokenized output has correct PRG header ($0801)."""
        tokenizer_ctx.eval('var tokenizer = new BASICTokenizer()')
        result = tokenizer_ctx.eval('''
            var result = tokenizer.tokenize('10 PRINT "HI"');
            var header = result.bytes[0] | (result.bytes[1] << 8);
            header
        ''')
        assert result == 0x0801, f'PRG header should be $0801, got ${hex(result)}'
    
    def test_print_token(self, tokenizer_ctx):
        """Test that PRINT is correctly tokenized as $99."""
        tokenizer_ctx.eval('var tokenizer = new BASICTokenizer()')
        # The structure is: [PRG 2] [next 2] [linenum 2] [tokens...] [0x00] [end 2]
        # For "10 PRINT", token should be at byte 6 (after PRG header, next ptr, line num)
        tokenizer_ctx.eval('var result = tokenizer.tokenize("10 PRINT")')
        token_byte = tokenizer_ctx.eval('result.bytes[6]')
        
        # Bytes 0-1: PRG header ($01 $08)
        # Bytes 2-3: Next line pointer
        # Bytes 4-5: Line number (10, 0)
        # Byte 6: First token (PRINT = $99)
        assert token_byte == 0x99, f'PRINT token should be $99, got ${hex(token_byte)}'
    
    def test_multiple_lines(self, tokenizer_ctx):
        """Test tokenizing multiple lines."""
        tokenizer_ctx.eval('var tokenizer = new BASICTokenizer()')
        tokenizer_ctx.eval('var result = tokenizer.tokenize("10 PRINT \\"A\\"\\n20 GOTO 10")')
        error_count = tokenizer_ctx.eval('result.errors.length')
        line_count = tokenizer_ctx.eval('result.lines.length')
        
        assert error_count == 0, 'Should have no errors'
        assert line_count == 2, 'Should have 2 lines'
    
    def test_error_no_line_number(self, tokenizer_ctx):
        """Test that missing line number is detected as error."""
        tokenizer_ctx.eval('var tokenizer = new BASICTokenizer()')
        result = tokenizer_ctx.eval('''
            var result = tokenizer.tokenize('PRINT "NO LINE NUMBER"');
            result.errors.length
        ''')
        assert result > 0, 'Should detect missing line number error'
    
    def test_validate_unmatched_quote(self, tokenizer_ctx):
        """Test validation detects unmatched quotes."""
        tokenizer_ctx.eval('var tokenizer = new BASICTokenizer()')
        result = tokenizer_ctx.eval('''
            var errors = tokenizer.validate('10 PRINT "UNCLOSED');
            errors.length
        ''')
        assert result > 0, 'Should detect unmatched quote'
    
    def test_validate_goto_without_target(self, tokenizer_ctx):
        """Test validation detects GOTO without target."""
        tokenizer_ctx.eval('var tokenizer = new BASICTokenizer()')
        result = tokenizer_ctx.eval('''
            var errors = tokenizer.validate('10 GOTO');
            errors.some(function(e) { return e.type === "error"; })
        ''')
        assert result is True, 'Should detect GOTO without target as error'
    
    def test_keyword_tokens(self, tokenizer_ctx):
        """Test that common keywords are tokenized correctly."""
        tokenizer_ctx.eval('var tokenizer = new BASICTokenizer()')
        
        # Test several common tokens
        test_cases = [
            ('10 END', 0x80),      # END
            ('10 FOR', 0x81),      # FOR
            ('10 NEXT', 0x82),     # NEXT
            ('10 DATA', 0x83),     # DATA
            ('10 GOTO', 0x89),     # GOTO
            ('10 IF', 0x8B),       # IF
            ('10 REM TEST', 0x8F), # REM
            ('10 POKE', 0x97),     # POKE
        ]
        
        for code, expected_token in test_cases:
            result = tokenizer_ctx.eval(f'''
                var result = tokenizer.tokenize('{code}');
                result.bytes[6]
            ''')
            assert result == expected_token, f'Token for {code} should be ${hex(expected_token)}, got ${hex(result)}'


class TestSyntaxHighlighting:
    """Tests for syntax highlighting functions."""
    
    def test_highlight_basic_exists(self, tokenizer_ctx):
        """Test that highlightBasic function exists."""
        result = tokenizer_ctx.eval('typeof highlightBasic')
        assert result == 'function'
    
    def test_highlight_returns_tokens(self, tokenizer_ctx):
        """Test that highlighting returns token array."""
        result = tokenizer_ctx.eval('''
            var tokens = highlightBasic('10 PRINT "HELLO"');
            Array.isArray(tokens)
        ''')
        assert result is True
    
    def test_highlight_keyword_token(self, tokenizer_ctx):
        """Test that PRINT is highlighted as keyword."""
        result = tokenizer_ctx.eval('''
            var tokens = highlightBasic('10 PRINT');
            tokens.some(function(t) { return t.type === 'keyword' && t.text.toUpperCase() === 'PRINT'; })
        ''')
        assert result is True, 'PRINT should be highlighted as keyword'
    
    def test_highlight_string_token(self, tokenizer_ctx):
        """Test that strings are highlighted correctly."""
        result = tokenizer_ctx.eval('''
            var tokens = highlightBasic('10 PRINT "HELLO"');
            tokens.some(function(t) { return t.type === 'string'; })
        ''')
        assert result is True, 'Should have string tokens'
    
    def test_highlight_line_number(self, tokenizer_ctx):
        """Test that line numbers are highlighted."""
        result = tokenizer_ctx.eval('''
            var tokens = highlightBasic('10 PRINT');
            tokens.some(function(t) { return t.type === 'linenumber' && t.text === '10'; })
        ''')
        assert result is True, 'Line number should be highlighted as linenumber'
    
    def test_highlight_comment(self, tokenizer_ctx):
        """Test that REM comments are highlighted."""
        result = tokenizer_ctx.eval('''
            var tokens = highlightBasic('10 REM THIS IS A COMMENT');
            tokens.some(function(t) { return t.type === 'comment'; })
        ''')
        assert result is True, 'REM content should be highlighted as comment'


class TestAssemblyHighlighting:
    """Tests for assembly language highlighting."""
    
    def test_highlight_assembly_exists(self, tokenizer_ctx):
        """Test that highlightAssembly function exists."""
        result = tokenizer_ctx.eval('typeof highlightAssembly')
        assert result == 'function'
    
    def test_highlight_asm_instruction(self, tokenizer_ctx):
        """Test that assembly instructions are highlighted."""
        # Test with just the instruction, no operand
        result = tokenizer_ctx.eval('''
            var tokens = highlightAssembly('    LDA $D020');
            tokens.some(function(t) { return t.type === 'keyword'; })
        ''')
        assert result is True, 'Should have keyword token for LDA'
    
    def test_highlight_asm_hex_number(self, tokenizer_ctx):
        """Test that hex numbers are highlighted."""
        result = tokenizer_ctx.eval('''
            var tokens = highlightAssembly('LDA $D020');
            tokens.some(function(t) { return t.type === 'number' && t.text === '$D020'; })
        ''')
        assert result is True, 'Hex number should be highlighted'
    
    def test_highlight_asm_comment(self, tokenizer_ctx):
        """Test that assembly comments are highlighted."""
        result = tokenizer_ctx.eval('''
            var tokens = highlightAssembly('; This is a comment');
            tokens.some(function(t) { return t.type === 'comment'; })
        ''')
        assert result is True, 'Comment should be highlighted'


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
