"""
Pytest-compatible tests for SID player functionality.

These tests use the pytest fixtures from conftest.py and follow
pytest conventions for automatic test discovery.
"""

import json
import pytest
from pathlib import Path

from tests.test_utils import call_js_test, call_js_test_with_bytes

# Import fixtures from conftest - they're available automatically


class TestSidParsing:
    """Tests for SID file parsing functionality."""

    def test_parse_great_giana_sisters(self, sid_player_context, giana_sisters_bytes):
        """Test parsing Great Giana Sisters SID file."""
        result = call_js_test_with_bytes(sid_player_context, "testParseSidFile", giana_sisters_bytes)
        
        assert result['success']
        assert result['magic'] in ['PSID', 'RSID']
        assert 'Giana' in result['name']
        assert result['songs'] > 0

    def test_parse_cybernoid(self, sid_player_context, cybernoid_bytes):
        """Test parsing Cybernoid SID file."""
        result = call_js_test_with_bytes(sid_player_context, "testParseSidFile", cybernoid_bytes)
        
        assert result['success']
        assert result['magic'] in ['PSID', 'RSID']
        assert 'Cybernoid' in result['name']

    def test_parse_last_ninja(self, sid_player_context, last_ninja_bytes):
        """Test parsing Last Ninja SID file."""
        result = call_js_test_with_bytes(sid_player_context, "testParseSidFile", last_ninja_bytes)
        
        assert result['success']
        assert result['magic'] in ['PSID', 'RSID']


class TestPlayerInitialization:
    """Tests for SID player initialization using C64Machine."""

    def test_initialize_player(self, sid_player_context, giana_sisters_bytes):
        """Test that C64Machine initializes correctly with a SID tune."""
        result = call_js_test_with_bytes(sid_player_context, "testLoadSidTune", giana_sisters_bytes)
        
        assert result['success']
        assert result['initialized']
        assert result['startSong'] >= 1
        assert result['clockFrequency'] > 0


class TestAudioGeneration:
    """Tests for audio sample generation using C64Machine."""

    def test_generate_samples(self, sid_player_context, giana_sisters_bytes):
        """Test that audio samples can be generated using C64Machine."""
        result = call_js_test_with_bytes(sid_player_context, "testSidAudioGeneration", giana_sisters_bytes, 50)
        
        assert result['success'], f"Failed to generate audio: {result.get('error')}"
        assert result['generated'] > 0, f"Should generate audio samples, got {result}"
        assert result['hasVariation'], f"Audio should have amplitude variation, got {result}"


class TestCPUEmulation:
    """Tests for 6510 CPU emulation."""

    def test_cpu_memory_operations(self, sid_player_context):
        """Test CPU memory read/write operations."""
        result = call_js_test(sid_player_context, "testCpuMemoryOps")
        
        assert result['val1'] == 0x42
        assert result['val2'] == 0xFF
        assert result['val3'] == 0x00

    def test_cpu_register_operations(self, sid_player_context):
        """Test CPU register operations."""
        result = call_js_test(sid_player_context, "testCpuRegisterOps")
        
        assert result['a'] == 0x55
        assert result['x'] == 0xAA
        assert result['y'] == 0x33
        assert result['sp'] == 0xFF


class TestSIDEmulation:
    """Tests for SID chip emulation."""

    def test_sid_write_registers(self, sid_player_context):
        """Test writing to SID registers."""
        result = call_js_test(sid_player_context, "testSidWriteRegisters")
        assert result['success']

    def test_sid_clock_cycles(self, sid_player_context):
        """Test SID chip clocking produces samples."""
        result = call_js_test(sid_player_context, "testSidClockCycles")
        assert result['sampleCount'] == 10


class TestEnvelopeGenerator:
    """Tests for ADSR envelope generator."""

    def test_envelope_attack(self, sid_player_context):
        """Test that envelope attack phase works."""
        result = call_js_test(sid_player_context, "testEnvelopeAttack")
        assert len(result['outputs']) > 0


class TestWaveformGenerator:
    """Tests for waveform generator."""

    def test_waveform_generator_creation(self, sid_player_context):
        """Test waveform generator can be created."""
        result = call_js_test(sid_player_context, "testWaveformGeneratorCreation")
        
        assert result['success']
        assert result['hasAccumulator']
        assert result['hasFreq']
        assert result['hasPw']
