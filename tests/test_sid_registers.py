
import json
import pytest

from tests.test_utils import call_js_test_with_bytes


class TestSidRegisters:
    """Tests for SID register writes during playback."""

    def test_register_writes_detected(self, sid_player_context, giana_sisters_bytes):
        """Test that SID registers are written to during playback."""
        result = call_js_test_with_bytes(sid_player_context, "testSidRegisterWrites", giana_sisters_bytes, 50)
        
        print(f"Writes detected: {result['totalWrites']}")
        print(f"First few writes: {result['sampleWrites']}")
        print(f"Final PC: {result['pc']:x}")
        
        assert result['totalWrites'] > 0, "No SID register writes detected!"
