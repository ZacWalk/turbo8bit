"""
Pytest configuration and shared fixtures for SID player tests.

These tests use py_mini_racer to run the JavaScript SID player code 
in a test context, verifying the C64 SID chip emulation.
"""

from pathlib import Path

import pytest

from tests.test_utils import (
    PROJECT_ROOT,
    JS_DIR,
    SID_DIR,
    load_js_file,
    load_sid_file,
    strip_es6_imports_exports,
    create_mini_racer_context,
    create_sid_player_context as _create_sid_player_context,
)

# Re-export for backwards compatibility with scripts that import from conftest
__all__ = [
    'PROJECT_ROOT',
    'JS_DIR', 
    'SID_DIR',
    'load_js_file',
    'load_sid_file',
    'strip_es6_imports_exports',
]


@pytest.fixture
def project_root() -> Path:
    """Return the project root directory."""
    return PROJECT_ROOT


@pytest.fixture
def js_dir() -> Path:
    """Return the JavaScript SID module directory."""
    return JS_DIR


@pytest.fixture
def sid_dir() -> Path:
    """Return the SID files directory."""
    return SID_DIR


@pytest.fixture
def mini_racer_context():
    """Create a MiniRacer context with browser-like environment."""
    return create_mini_racer_context()


@pytest.fixture
def sid_player_context(mini_racer_context):
    """Create a MiniRacer context with the SID player modules loaded.
    
    This now loads C64Machine modules instead of the legacy SIDPlayer.
    C64Machine provides full C64 emulation for SID playback.
    """
    # We create a fresh context rather than extending mini_racer_context
    # to ensure all modules are loaded in the correct order
    return _create_sid_player_context()


@pytest.fixture
def giana_sisters_bytes() -> list[int]:
    """Load the Great Giana Sisters SID file."""
    sid_path = SID_DIR / "Great_Giana_Sisters.sid"
    return load_sid_file(sid_path)


@pytest.fixture
def cybernoid_bytes() -> list[int]:
    """Load the Cybernoid SID file."""
    sid_path = SID_DIR / "Cybernoid.sid"
    return load_sid_file(sid_path)


@pytest.fixture
def last_ninja_bytes() -> list[int]:
    """Load the Last Ninja SID file."""
    sid_path = SID_DIR / "Last_Ninja.sid"
    return load_sid_file(sid_path)
