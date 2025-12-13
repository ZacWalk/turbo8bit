"""
Common utilities for C64 emulator tests.

This module provides shared functionality for running JavaScript C64 emulator
code in py_mini_racer, including:
- Path constants (PROJECT_ROOT, JS_DIR, SID_DIR, CRT_DIR)
- File loading utilities (load_js_file, load_sid_file, load_crt_file)
- ES6 module conversion (strip_es6_imports_exports)
- MiniRacer context creation with browser polyfills
- Pre-configured contexts for C64 machine and SID player
"""

import json
from pathlib import Path

from py_mini_racer import MiniRacer


# =============================================================================
# Path Constants
# =============================================================================

PROJECT_ROOT = Path(__file__).parent.parent
TESTS_DIR = Path(__file__).parent
JS_DIR = PROJECT_ROOT / "web" / "static" / "js" / "emulator"
JS_STATIC_DIR = PROJECT_ROOT / "web" / "static" / "js"
STATIC_DIR = PROJECT_ROOT / "web" / "static"
SID_DIR = PROJECT_ROOT / "web" / "static" / "sid"
CRT_DIR = PROJECT_ROOT / "web" / "static" / "crt"
TEST_JS_DIR = TESTS_DIR / "js"


# =============================================================================
# File Loading Utilities
# =============================================================================

def load_js_file(path: Path) -> str:
    """Load a JavaScript file as a string."""
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def load_sid_file(path: Path) -> list[int]:
    """Load a SID file as a list of bytes."""
    with open(path, 'rb') as f:
        return list(f.read())


def load_crt_file(path: Path) -> list[int]:
    """Load a CRT file as a list of bytes."""
    with open(path, 'rb') as f:
        return list(f.read())


def load_binary_file(path: Path) -> list[int]:
    """Load any binary file as a list of bytes."""
    with open(path, 'rb') as f:
        return list(f.read())


# =============================================================================
# ES6 Module Conversion
# =============================================================================

def strip_es6_imports_exports(code: str) -> str:
    """Strip ES6 import/export statements and convert to plain JS.
    
    Converts ES6 module code to work in MiniRacer:
    - Removes import statements (modules are loaded in order, all share global scope)
    - Removes 'export' keyword from exports
    - Removes 'export default' statements entirely
    - Converts 'const' to 'var' for top-level declarations (needed for global scope)
    """
    lines = code.split('\n')
    result = []
    for line in lines:
        stripped = line.strip()
        # Skip import statements
        if stripped.startswith('import '):
            continue
        # Skip re-export statements like: export { Foo } from './bar.js';
        if stripped.startswith('export {') and ' from ' in stripped:
            continue
        # Skip 'export default Identifier;' statements entirely
        if stripped.startswith('export default ') and stripped.endswith(';'):
            continue
        # Remove 'export' keyword from regular exports
        if stripped.startswith('export '):
            line = line.replace('export ', '', 1)
            stripped = line.strip()
        # Convert top-level 'const' to 'var' for global scope in MiniRacer
        # This is needed because 'const' creates block-scoped variables
        if stripped.startswith('const ') and not line.startswith('    ') and not line.startswith('\t'):
            line = line.replace('const ', 'var ', 1)
        result.append(line)
    return '\n'.join(result)


def strip_es6_with_async(code: str) -> str:
    """Strip ES6 imports/exports and also skip async functions (which use fetch).
    
    This variant is useful for files that contain async functions that
    use browser APIs like fetch() which aren't available in MiniRacer.
    """
    lines = code.split('\n')
    result = []
    skip_function = False
    brace_depth = 0
    
    for line in lines:
        stripped = line.strip()
        
        # Start skipping when we hit an async function (uses browser APIs like fetch)
        if 'async function' in stripped:
            skip_function = True
            brace_depth = 0
        
        if skip_function:
            brace_depth += line.count('{') - line.count('}')
            # When we close the function (brace_depth back to 0 after opening), stop skipping
            if brace_depth == 0 and '}' in stripped:
                skip_function = False
            continue
        
        # Skip import statements
        if stripped.startswith('import '):
            continue
        # Skip re-export statements like: export { Foo } from './bar.js';
        if stripped.startswith('export {') and ' from ' in stripped:
            continue
        # Handle "export default VARNAME;" - just skip it entirely
        if stripped.startswith('export default ') and stripped.endswith(';'):
            continue
        # Remove 'export default' prefix (like export default { ... })
        if stripped.startswith('export default '):
            line = line.replace('export default ', 'var __default__ = ', 1)
            stripped = line.strip()
        # Remove 'export' keyword from regular exports
        elif stripped.startswith('export '):
            line = line.replace('export ', '', 1)
            stripped = line.strip()
        # Convert top-level 'const' to 'var' for global scope in MiniRacer
        if stripped.startswith('const ') and not line.startswith('    ') and not line.startswith('\t'):
            line = line.replace('const ', 'var ', 1)
        result.append(line)
    return '\n'.join(result)


# =============================================================================
# Browser Environment Polyfills
# =============================================================================

BROWSER_POLYFILLS = """
var window = {
    addEventListener: function() {},
    removeEventListener: function() {}
};
var sessionStorage = {
    getItem: function() { return null; },
    setItem: function() {}
};
var console = { 
    log: function() {}, 
    warn: function() {}, 
    error: function() {} 
};
var performance = { now: function() { return Date.now(); } };

// TextDecoder polyfill for py_mini_racer
var TextDecoder = function(encoding) {
    this.encoding = encoding || 'utf-8';
};
TextDecoder.prototype.decode = function(bytes) {
    var result = '';
    var arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (var i = 0; i < arr.length; i++) {
        if (arr[i] === 0) break;
        result += String.fromCharCode(arr[i]);
    }
    return result;
};
"""

MINIMAL_BROWSER_ENV = """
var window = {};
var console = { 
    log: function() {}, 
    warn: function() {}, 
    error: function() {} 
};
"""


# =============================================================================
# MiniRacer Context Creation
# =============================================================================

def create_mini_racer_context(polyfills: str = BROWSER_POLYFILLS) -> MiniRacer:
    """Create a MiniRacer context with browser-like environment polyfills.
    
    Args:
        polyfills: JavaScript code to set up the browser environment.
                  Defaults to full polyfills. Use MINIMAL_BROWSER_ENV for simple cases.
    """
    ctx = MiniRacer()
    ctx.eval(polyfills)
    return ctx


def load_js_modules(ctx: MiniRacer, modules: list[str], js_dir: Path = JS_DIR) -> None:
    """Load a list of JavaScript modules into the MiniRacer context.
    
    Args:
        ctx: MiniRacer context to load modules into.
        modules: List of module filenames to load (e.g., ["roms.js", "sid.js"]).
        js_dir: Directory containing the JS files. Defaults to JS_DIR (emulator/).
    """
    for module in modules:
        js_path = js_dir / module
        if not js_path.exists():
            raise FileNotFoundError(f"Module not found: {js_path}")
        code = strip_es6_imports_exports(load_js_file(js_path))
        try:
            ctx.eval(code)
        except Exception as e:
            raise RuntimeError(f"Error loading {module}: {e}")


# =============================================================================
# Pre-configured Contexts
# =============================================================================

# Standard C64 machine modules in load order
C64_MACHINE_MODULES = [
    "roms.js",
    "voice.js",
    "filter.js",
    "sid.js",
    "mos6510.js",
    "vic-ii.js",
    "machine.js",
]

# SID player modules (includes machine + SID-specific)
SID_PLAYER_MODULES = [
    "roms.js",
    "voice.js",
    "filter.js",
    "sid.js",
    "mos6510.js",
    "vic-ii.js",
    "machine.js",
    "psid-driver.js",
    "sid-player.js",
]

# Cartridge-enabled modules
CRT_MODULES = [
    "roms.js",
    "voice.js",
    "filter.js",
    "sid.js",
    "mos6510.js",
    "vic-ii.js",
    "cartridge.js",
    "machine.js",
]


def create_c64_context() -> MiniRacer:
    """Create a MiniRacer context with the C64 machine loaded."""
    ctx = create_mini_racer_context()
    load_js_modules(ctx, C64_MACHINE_MODULES)
    load_test_helpers(ctx)
    return ctx


def create_sid_player_context() -> MiniRacer:
    """Create a MiniRacer context with C64Machine and SID player loaded.
    
    Includes backward compatibility wrapper so tests can use machine.loadSidTune(buffer).
    Also loads test helper functions from tests/js/test-helpers.js.
    """
    ctx = create_mini_racer_context()
    load_js_modules(ctx, SID_PLAYER_MODULES)
    
    # Add backward compatibility wrapper
    ctx.eval("""
        C64Machine.prototype.loadSidTune = function(buffer, song) {
            return loadSidTune(this, buffer, song);
        };
    """)
    
    # Load test helpers
    load_test_helpers(ctx)
    
    return ctx


def create_crt_context() -> MiniRacer:
    """Create a MiniRacer context with C64Machine and cartridge support loaded."""
    ctx = create_mini_racer_context()
    load_js_modules(ctx, CRT_MODULES)
    load_test_helpers(ctx)
    return ctx


def load_test_helpers(ctx: MiniRacer) -> None:
    """Load JavaScript test helper functions into the context."""
    helpers_path = TEST_JS_DIR / "test-helpers.js"
    if helpers_path.exists():
        code = load_js_file(helpers_path)
        ctx.eval(code)


# =============================================================================
# Helper Functions
# =============================================================================

def eval_json(ctx: MiniRacer, script: str) -> dict:
    """Evaluate a script that returns an object, wrapping in JSON.stringify."""
    result_json = ctx.eval(f"JSON.stringify({script})")
    return json.loads(result_json)


def call_js_test(ctx: MiniRacer, func_name: str, *args) -> dict:
    """Call a JavaScript test helper function and return its result.
    
    Args:
        ctx: MiniRacer context with test helpers loaded.
        func_name: Name of the JavaScript function to call.
        *args: Arguments to pass to the function (will be JSON serialized).
        
    Returns:
        The function's return value as a Python dict.
    """
    args_json = ', '.join(json.dumps(arg) for arg in args)
    if args_json:
        script = f"{func_name}({args_json})"
    else:
        script = f"{func_name}()"
    return eval_json(ctx, script)


def call_js_test_with_bytes(ctx: MiniRacer, func_name: str, byte_data: list[int], *args) -> dict:
    """Call a JS test function where first arg is byte array data.
    
    This is optimized for passing SID/CRT file data efficiently.
    
    Args:
        ctx: MiniRacer context with test helpers loaded.
        func_name: Name of the JavaScript function to call.
        byte_data: List of bytes to pass as first argument (Uint8Array).
        *args: Additional arguments to pass.
        
    Returns:
        The function's return value as a Python dict.
    """
    # Set the byte data as a global variable to avoid re-serializing
    ctx.eval(f"var __testBytes = new Uint8Array({json.dumps(byte_data)});")
    
    if args:
        args_json = ', '.join(json.dumps(arg) for arg in args)
        script = f"{func_name}(__testBytes, {args_json})"
    else:
        script = f"{func_name}(__testBytes)"
    
    return eval_json(ctx, script)
