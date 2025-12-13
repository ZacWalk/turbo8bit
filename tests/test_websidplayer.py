import pytest
import json

from tests.test_utils import (
    SID_DIR,
    create_sid_player_context,
    BROWSER_POLYFILLS,
)
from py_mini_racer import MiniRacer


def test_websidplayer_runs():
    ctx = MiniRacer()

    # Browser polyfills - extended version with AudioContext mock
    ctx.eval(BROWSER_POLYFILLS)
    ctx.eval('''
    // Override window with AudioContext support
    window.webkitAudioContext = null;
    
    // Mock AudioContext and related classes
    class AudioWorkletNode {
        constructor(context, name) {
            this.port = {
                onmessage: null,
                postMessage: function(msg) {}
            };
            this.connect = function() {};
            this.disconnect = function() {};
        }
    }
    
    class AudioContext {
        constructor(options) {
            this.sampleRate = options && options.sampleRate ? options.sampleRate : 44100;
            this.state = 'suspended';
            this.destination = {};
            this.audioWorklet = {
                addModule: async function(url) { return Promise.resolve(); }
            };
        }
        
        resume() {
            this.state = 'running';
            return Promise.resolve();
        }
        
        createScriptProcessor(bufferSize, inputChannels, outputChannels) {
            return {
                connect: function() {},
                disconnect: function() {},
                onaudioprocess: null
            };
        }
        
        close() {}
    }
    
    window.AudioContext = AudioContext;
    window.AudioWorkletNode = AudioWorkletNode;
    ''')

    # Load emulator modules using test_utils
    from tests.test_utils import load_js_modules, JS_DIR, SID_PLAYER_MODULES
    load_js_modules(ctx, SID_PLAYER_MODULES, JS_DIR)

    # Add backward compatibility wrapper
    ctx.eval('''
        C64Machine.prototype.loadSidTune = function(buffer, song) {
            return loadSidTune(this, buffer, song);
        };
    ''')

    # Load SID bytes
    sid_path = SID_DIR / 'Last_Ninja.sid'
    assert sid_path.exists(), f"SID file not found at {sid_path}"

    sid_bytes = list(sid_path.read_bytes())
    ctx.eval(f'var sidBytes = {json.dumps(sid_bytes)};')

    # Test SIDPlayer
    ctx.eval('''
    var testResult = null;
    var testError = null;
    
    (async function() {
        try {
            var buffer = new Uint8Array(sidBytes).buffer;
            var player = new SIDPlayer();
            player.loadData(buffer);
            
            if (!player.sidFile) throw new Error("Failed to load SID file");
            
            await player.play();
            
            if (!player.isPlaying) throw new Error("Player failed to start");
            
            var outputBuffer = new Float32Array(4096);
            player.generateSamples(outputBuffer);
            
            var nonZeroSamples = 0;
            for (var i = 0; i < outputBuffer.length; i++) {
                if (outputBuffer[i] !== 0) nonZeroSamples++;
            }
            
            testResult = JSON.stringify({
                success: true,
                isPlaying: player.isPlaying,
                useWorklet: player.useWorklet,
                tuneName: player.sidFile.name,
                nonZeroSamples: nonZeroSamples,
                sampleRate: player.sampleRate
            });
        } catch (e) {
            testError = JSON.stringify({ success: false, error: e.toString(), stack: e.stack });
        }
    })();
    ''')
    
    # Poll for result
    result = None
    for _ in range(20):
        res = ctx.eval('testResult')
        err = ctx.eval('testError')
        if res:
            result = json.loads(res)
            break
        if err:
            pytest.fail(f"JS Error: {err}")
        time.sleep(0.1)
        
    assert result is not None, "Timeout waiting for test result"
    assert result['success'] is True
    assert result['isPlaying'] is True
    assert result['nonZeroSamples'] > 0, "No audio samples generated"
    assert result['tuneName'] == "The Last Ninja"
