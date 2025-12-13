import os
import json
import subprocess
import sys
from py_mini_racer import MiniRacer

def load_js_module(ctx, path):
    """Load a JavaScript module, stripping ES6 import/export."""
    with open(path, 'r', encoding='utf-8') as f:
        code = f.read()
    
    # Strip ES6 imports/exports
    lines = []
    for line in code.split('\n'):
        if line.strip().startswith('import '):
            continue
        if line.strip().startswith('export default'):
            line = line.replace('export default', '')
        if line.strip().startswith('export '):
            line = line.replace('export ', '')
        lines.append(line)
    
    return '\n'.join(lines)

def build_demo():
    print("Building demo...")
    
    # 1. Generate assets
    print("Generating assets...")
    # Ensure we are in the demo directory or reference it correctly
    demo_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(demo_dir)
    script_path = os.path.join(demo_dir, "gen_char_set_from_image.py")
    image_path = os.path.join(demo_dir, "walker.png")
    output_base = os.path.join(demo_dir, "walker")
    
    # Run generation script (80x25 = double width, screen height for horizontal scroll)
    cmd = [sys.executable, script_path, image_path, output_base, "--width", "80", "--height", "25"]
    subprocess.check_call(cmd)
    
    # 2. Read files
    print("Reading files...")
    asm_path = os.path.join(demo_dir, "demo.asm")
    chars_path = os.path.join(demo_dir, "walker_chars.bin")
    map_path = os.path.join(demo_dir, "walker_map.bin")
    colors_path = os.path.join(demo_dir, "walker_colors.bin")
    
    with open(asm_path, "r") as f:
        source = f.read()
        
    with open(chars_path, "rb") as f:
        chars_data = list(f.read())
        
    with open(map_path, "rb") as f:
        map_data = list(f.read())
    
    with open(colors_path, "rb") as f:
        colors_data = list(f.read())

    # 3. Assemble using py_mini_racer
    print("Assembling...")
    ctx = MiniRacer()
    
    # Load assembler.js
    assembler_js_path = os.path.join(root_dir, "web", "static", "js", "emulator", "assembler.js")
    assembler_code = load_js_module(ctx, assembler_js_path)
    ctx.eval(assembler_code)
    
    # Initialize assembler
    ctx.eval('var asm = new Assembler();')
    
    # Set files
    files = {
        "walker_chars.bin": chars_data,
        "walker_map.bin": map_data,
        "walker_colors.bin": colors_data
    }
    
    # Pass files to JS using eval to preserve 'this' context
    # We serialize to JSON to pass the data safely
    ctx.eval(f'var files = {json.dumps(files)};')
    ctx.eval('asm.setFiles(files);')
    
    # Assemble
    # Pass source code safely
    ctx.eval(f'var source = {json.dumps(source)};')
    ctx.eval('var result = asm.assemble(source);')
    
    # Convert Uint8Array to Array for JSON serialization
    ctx.eval('result.bytes = Array.from(result.bytes);')
    
    # Return as JSON string to avoid JSObject issues
    result_json = ctx.eval('JSON.stringify(result)')
    result = json.loads(result_json)
    
    if not result['success']:
        print("Assembly failed!")
        for error in result['errors']:
            print(f"Line {error['lineNum']}: {error['message']}")
        sys.exit(1)
        
    print("Assembly successful!")
    
    # 4. Create PRG file
    # PRG format: [Low Address] [High Address] [Data...]
    start_addr = result['startAddress']
    bytes_data = result['bytes'] # This comes back as a list of integers
    
    prg_data = bytearray()
    prg_data.append(start_addr & 0xFF)
    prg_data.append((start_addr >> 8) & 0xFF)
    prg_data.extend(bytes_data)
    
    # 5. Save PRG to web/static directory
    output_path = os.path.join(root_dir, "web", "static", "demo.prg")
    with open(output_path, "wb") as f:
        f.write(prg_data)
        
    print(f"Demo built successfully! Saved to {output_path}")

    # 6. Generate preview image
    print("Generating preview...")
    preview_script = os.path.join(demo_dir, "render_preview.py")
    preview_cmd = [
        sys.executable, preview_script,
        "--charset", chars_path,
        "--map", map_path,
        "--colors", colors_path,
        "--output", os.path.join(demo_dir, "logo_preview.png"),
        "--width", "80",
        "--height", "25",
        "--scale", "2"
    ]
    subprocess.check_call(preview_cmd)

    # 7. Save JSON bundle to demo directory (optional, but requested)
    bundle = {
        "source": source,
        "files": {
            "walker_chars.bin": chars_data,
            "walker_map.bin": map_data
        }
    }
    json_path = os.path.join(demo_dir, "demo.json")
    with open(json_path, "w") as f:
        json.dump(bundle, f)
    print(f"JSON bundle saved to {json_path}")

if __name__ == "__main__":
    build_demo()
