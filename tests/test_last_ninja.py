
import json
import pytest
import os

class TestLastNinja:
    """Tests for Last Ninja SID playback."""

    def test_last_ninja_writes(self, sid_player_context):
        """Test that Last Ninja writes to SID registers."""
        ctx = sid_player_context
        
        # Load Last Ninja SID
        sid_path = os.path.join('web', 'static', 'sid', 'Last_Ninja.sid')
        with open(sid_path, 'rb') as f:
            sid_bytes = list(f.read())
            
        ctx.eval(f"var sidBytes = {json.dumps(sid_bytes)};")
        
        result_json = ctx.eval("""
            JSON.stringify((function() {
                var buffer = new Uint8Array(sidBytes).buffer;
                var machine = new C64Machine({ audioEnabled: true });
                var tune = machine.loadSidTune(buffer);
                
                // Intercept SID writes
                var writeCount = 0;
                var writes = [];
                var originalWrite = machine.sid.write.bind(machine.sid);
                
                machine.sid.write = function(offset, value, cycle) {
                    writeCount++;
                    if (writes.length < 20) {
                        writes.push({offset: offset, value: value, cycle: cycle});
                    }
                    originalWrite(offset, value, cycle);
                };
                
                // Trace first few instructions of Play routine
                var trace = [];
                var traceLimit = 50;
                
                // Hook into CPU step? No easy way without modifying CPU.
                // But we can check PC after each frame.
                
                var pcs = [];
                
                // Run frames
                for (var frame = 0; frame < 50; frame++) {
                    machine.runFrame();
                    pcs.push(machine.cpu.PC);
                }
                
                return {
                    writeCount: writeCount,
                    writes: writes,
                    pcs: pcs,
                    initAddr: tune.initAddress,
                    playAddr: tune.playAddress
                };
            })())
        """)
        result = json.loads(result_json)
        
        print(f"Writes detected: {result['writeCount']}")
        print(f"First few writes: {result['writes']}")
        print(f"PCs per frame: {[hex(pc) for pc in result['pcs']]}")
        
        assert result['writeCount'] > 0, "No SID register writes detected for Last Ninja!"
