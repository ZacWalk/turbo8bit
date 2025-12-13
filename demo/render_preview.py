"""
Generate a PNG preview of how the logo will look as a C64 charset.

This script reads the walker_chars.bin (charset), walker_map.bin (screen map),
and optionally walker_colors.bin (color map) files and renders a preview image
showing what the logo looks like with the custom charset and colors applied.
"""

from pathlib import Path
from PIL import Image
import numpy as np

# C64 color palette (Pepto's palette) - all 16 colors
C64_COLORS = [
    (0, 0, 0),       # 0: Black
    (255, 255, 255), # 1: White
    (136, 0, 0),     # 2: Red
    (170, 255, 238), # 3: Cyan
    (204, 68, 204),  # 4: Purple
    (0, 204, 85),    # 5: Green
    (0, 0, 170),     # 6: Blue
    (238, 238, 119), # 7: Yellow
    (221, 136, 85),  # 8: Orange
    (102, 68, 0),    # 9: Brown
    (255, 119, 119), # 10: Light Red
    (51, 51, 51),    # 11: Dark Grey
    (119, 119, 119), # 12: Grey
    (170, 255, 102), # 13: Light Green
    (0, 136, 255),   # 14: Light Blue
    (187, 187, 187)  # 15: Light Grey
]

def render_c64_preview(
    charset_path: str,
    map_path: str,
    output_path: str,
    color_path: str = None,
    map_width: int = 80,
    map_height: int = 50,
    fg_color: tuple = (255, 255, 255),
    bg_color: tuple = (0, 0, 0),
    scale: int = 1
):
    """
    Render a preview of the C64 charset + map as a PNG.
    
    Args:
        charset_path: Path to the charset binary (256 chars × 8 bytes)
        map_path: Path to the screen map binary (width × height bytes)
        output_path: Where to save the PNG
        color_path: Optional path to color map binary (width × height bytes)
        map_width: Width of the map in characters (default 80)
        map_height: Height of the map in characters (default 50)
        fg_color: Default foreground color RGB tuple (used if no color map)
        bg_color: Background color RGB tuple
        scale: Scale factor for output image
    """
    # Read charset data
    charset_data = Path(charset_path).read_bytes()
    
    # Parse charset into 256 characters, each 8 bytes
    chars = []
    for i in range(256):
        char_bytes = charset_data[i*8:(i+1)*8]
        if len(char_bytes) < 8:
            char_bytes = bytes(8)  # Empty char if not enough data
        chars.append(char_bytes)
    
    # Read map data
    map_data = Path(map_path).read_bytes()
    
    # Read color data if provided
    color_data = None
    if color_path and Path(color_path).exists():
        color_data = Path(color_path).read_bytes()
        print(f"Using color map: {color_path}")
    
    # Calculate image dimensions
    img_width = map_width * 8
    img_height = map_height * 8
    
    # Create image array
    pixels = np.zeros((img_height, img_width, 3), dtype=np.uint8)
    
    # Fill with background color
    pixels[:, :] = bg_color
    
    # Render each character from the map
    for row in range(map_height):
        for col in range(map_width):
            map_offset = row * map_width + col
            if map_offset >= len(map_data):
                continue
            
            char_index = map_data[map_offset]
            char_data = chars[char_index]
            
            # Get foreground color for this cell
            if color_data and map_offset < len(color_data):
                color_index = color_data[map_offset] & 0x0F  # Low nibble = foreground
                cell_fg = C64_COLORS[color_index]
            else:
                cell_fg = fg_color
            
            # Render 8x8 character
            for cy in range(8):
                byte = char_data[cy] if cy < len(char_data) else 0
                for cx in range(8):
                    if byte & (0x80 >> cx):  # Bit set = foreground
                        px = col * 8 + cx
                        py = row * 8 + cy
                        if py < img_height and px < img_width:
                            pixels[py, px] = cell_fg
    
    # Create PIL image
    img = Image.fromarray(pixels, mode='RGB')
    
    # Scale if requested
    if scale > 1:
        img = img.resize(
            (img_width * scale, img_height * scale),
            resample=Image.Resampling.NEAREST
        )
    
    # Save
    img.save(output_path)
    print(f"Preview saved to {output_path}")
    print(f"Image size: {img.width}x{img.height} pixels")
    
    return img

def render_charset_grid(
    charset_path: str,
    output_path: str,
    fg_color: tuple = (255, 255, 255),
    bg_color: tuple = (0, 0, 0),
    scale: int = 2,
    chars_per_row: int = 16
):
    """
    Render all charset characters in a grid for visual reference.
    
    Args:
        charset_path: Path to the charset binary
        output_path: Where to save the PNG
        fg_color: Foreground color RGB tuple  
        bg_color: Background color RGB tuple
        scale: Scale factor for output
        chars_per_row: Characters per row in grid
    """
    # Read charset data
    charset_data = Path(charset_path).read_bytes()
    
    # Parse charset
    chars = []
    for i in range(256):
        char_bytes = charset_data[i*8:(i+1)*8]
        if len(char_bytes) < 8:
            char_bytes = bytes(8)
        chars.append(char_bytes)
    
    # Calculate grid dimensions
    rows = (256 + chars_per_row - 1) // chars_per_row
    img_width = chars_per_row * 8
    img_height = rows * 8
    
    # Create image array
    pixels = np.zeros((img_height, img_width, 3), dtype=np.uint8)
    pixels[:, :] = bg_color
    
    # Render each character
    for char_index in range(256):
        row = char_index // chars_per_row
        col = char_index % chars_per_row
        char_data = chars[char_index]
        
        for cy in range(8):
            byte = char_data[cy] if cy < len(char_data) else 0
            for cx in range(8):
                if byte & (0x80 >> cx):
                    px = col * 8 + cx
                    py = row * 8 + cy
                    pixels[py, px] = fg_color
    
    # Create and save image
    img = Image.fromarray(pixels, mode='RGB')
    
    if scale > 1:
        img = img.resize(
            (img_width * scale, img_height * scale),
            resample=Image.Resampling.NEAREST
        )
    
    img.save(output_path)
    print(f"Charset grid saved to {output_path}")
    print(f"Image size: {img.width}x{img.height} pixels ({256} characters)")
    
    return img


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(
        description='Generate PNG preview of C64 charset rendering'
    )
    parser.add_argument(
        '--charset', '-c',
        default='demo/walker_chars.bin',
        help='Path to charset binary file'
    )
    parser.add_argument(
        '--map', '-m',
        default='demo/walker_map.bin', 
        help='Path to screen map binary file'
    )
    parser.add_argument(
        '--colors', '-C',
        default=None,
        help='Path to color map binary file (optional)'
    )
    parser.add_argument(
        '--output', '-o',
        default='demo/preview.png',
        help='Output PNG path'
    )
    parser.add_argument(
        '--grid', '-g',
        action='store_true',
        help='Generate charset grid instead of map preview'
    )
    parser.add_argument(
        '--scale', '-s',
        type=int,
        default=1,
        help='Scale factor for output image'
    )
    parser.add_argument(
        '--width', '-W',
        type=int,
        default=80,
        help='Map width in characters'
    )
    parser.add_argument(
        '--height', '-H',
        type=int,
        default=50,
        help='Map height in characters'
    )
    
    args = parser.parse_args()
    
    if args.grid:
        render_charset_grid(
            args.charset,
            args.output,
            scale=args.scale
        )
    else:
        # Auto-detect color file if not specified
        color_path = args.colors
        if color_path is None:
            # Try to find colors file based on map path
            map_base = Path(args.map).stem.replace('_map', '')
            potential_color = Path(args.map).parent / f"{map_base}_colors.bin"
            if potential_color.exists():
                color_path = str(potential_color)
                print(f"Auto-detected color map: {color_path}")
        
        render_c64_preview(
            args.charset,
            args.map,
            args.output,
            color_path=color_path,
            map_width=args.width,
            map_height=args.height,
            scale=args.scale
        )
