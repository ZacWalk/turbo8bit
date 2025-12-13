import argparse
import numpy as np
from PIL import Image
import os
from itertools import combinations

# --- C64 Palette (Pepto's Palette) ---
C64_PALETTE = [
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

# Convert palette to numpy array for vectorized operations
C64_PALETTE_NP = np.array(C64_PALETTE, dtype=np.float32)

# Bayer 8x8 ordered dithering matrix (normalized to 0-1 range)
# This creates a pattern that spreads error visually for smooth gradients
BAYER_8X8 = np.array([
    [ 0, 32,  8, 40,  2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44,  4, 36, 14, 46,  6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [ 3, 35, 11, 43,  1, 33,  9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47,  7, 39, 13, 45,  5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21]
], dtype=np.float32) / 64.0  # Normalize to 0-1


def color_distance_sq(c1, c2):
    """Calculate squared Euclidean distance between two colors."""
    return sum((a - b) ** 2 for a, b in zip(c1, c2))


def find_closest_color(rgb, palette=C64_PALETTE):
    """Find the closest C64 palette color to a given RGB color."""
    min_dist = float('inf')
    best_idx = 0
    for idx, pal_color in enumerate(palette):
        dist = color_distance_sq(rgb, pal_color)
        if dist < min_dist:
            min_dist = dist
            best_idx = idx
    return best_idx


def find_best_two_colors_dithered(block_rgb):
    """
    Find the best two C64 colors to represent an 8x8 block using ordered dithering.
    
    Uses Bayer matrix dithering to create smooth gradients between colors,
    avoiding solid blocks and creating a proper pixel art effect.
    
    Args:
        block_rgb: 8x8x3 numpy array of RGB values
        
    Returns:
        (bg_color_idx, fg_color_idx, char_bytes, total_error)
    """
    pixels = block_rgb.astype(np.float32)  # 8x8x3
    
    best_error = float('inf')
    best_bg = 0
    best_fg = 1
    best_pattern = None
    
    # Try all combinations of two colors from the palette
    for bg_idx, fg_idx in combinations(range(16), 2):
        bg_color = C64_PALETTE_NP[bg_idx]
        fg_color = C64_PALETTE_NP[fg_idx]
        
        # For each pixel, calculate where it falls between bg and fg colors
        # t=0 means pixel matches bg, t=1 means pixel matches fg
        
        # Vector from bg to fg
        color_diff = fg_color - bg_color
        color_diff_sq = np.sum(color_diff ** 2)
        
        if color_diff_sq < 1e-6:
            # Colors are identical, skip
            continue
        
        # Project each pixel onto the line between bg and fg
        # t = dot(pixel - bg, fg - bg) / |fg - bg|^2
        pixel_diff = pixels - bg_color  # 8x8x3
        t = np.sum(pixel_diff * color_diff, axis=2) / color_diff_sq  # 8x8
        
        # Clamp t to [0, 1]
        t = np.clip(t, 0, 1)
        
        # Apply ordered dithering: compare t against Bayer threshold
        # If t > threshold, use foreground, else use background
        pattern = (t > BAYER_8X8).astype(np.uint8)
        
        # Calculate actual error (how far each pixel is from assigned color)
        assigned_colors = np.where(pattern[:, :, np.newaxis], fg_color, bg_color)
        error = np.sum((pixels - assigned_colors) ** 2)
        
        if error < best_error:
            best_error = error
            best_bg = bg_idx
            best_fg = fg_idx
            best_pattern = pattern
    
    # Ensure foreground is the more frequently used color (convention)
    fg_count = np.sum(best_pattern)
    if fg_count < 32:  # If foreground has fewer pixels, swap
        best_bg, best_fg = best_fg, best_bg
        best_pattern = 1 - best_pattern
    
    # Convert pattern to char bytes (8 bytes, one per row)
    char_bytes = []
    for row in range(8):
        byte_val = 0
        for col in range(8):
            if best_pattern[row, col]:
                byte_val |= (1 << (7 - col))
        char_bytes.append(byte_val)
    
    return best_bg, best_fg, tuple(char_bytes), best_error


def generate_c64_artwork(image_path, output_base, chars_wide=80, chars_high=50):
    """
    Main function to process image and generate C64 data with per-cell colors.
    
    Generates three files:
    - {output_base}_chars.bin: Custom charset (2KB, 256 chars x 8 bytes)
    - {output_base}_map.bin: Screen map (chars_wide x chars_high bytes)
    - {output_base}_colors.bin: Color map (chars_wide x chars_high bytes)
      Each byte contains: high nibble = background, low nibble = foreground
    """
    
    # 1. Calculate Target Resolution
    pixel_width = chars_wide * 8
    pixel_height = chars_high * 8
    
    print(f"Processing {image_path}...")
    print(f"Target Grid: {chars_wide}x{chars_high} chars")
    print(f"Resolution: {pixel_width}x{pixel_height} pixels")

    if not os.path.exists(image_path):
        print(f"Error: {image_path} not found.")
        return

    # 2. Load and Resize Image
    img = Image.open(image_path).convert('RGB')
    
    # Resize logic: stretch to fit the grid
    img = img.resize((pixel_width, pixel_height), Image.Resampling.LANCZOS)
    
    # Convert to numpy array (keep as RGB, no quantization yet)
    pixels_rgb = np.array(img)

    # 3. Block Processing with Color Selection
    unique_chars = {}  # char_tuple -> index
    char_list = []     # ordered list of char tuples
    screen_map = []
    color_map = []
    
    # Track color usage statistics
    color_usage = {}
    total_error = 0
    
    for y in range(0, pixel_height, 8):
        row_indices = []
        row_colors = []
        for x in range(0, pixel_width, 8):
            # Extract 8x8 block as RGB
            block_rgb = pixels_rgb[y:y+8, x:x+8]
            
            # Find best two-color representation with dithering
            bg_idx, fg_idx, char_bytes, error = find_best_two_colors_dithered(block_rgb)
            total_error += error
            
            # Track color usage
            color_pair = (bg_idx, fg_idx)
            color_usage[color_pair] = color_usage.get(color_pair, 0) + 1
            
            # Check if this character already exists
            if char_bytes in unique_chars:
                char_idx = unique_chars[char_bytes]
            else:
                if len(char_list) < 256:
                    char_idx = len(char_list)
                    unique_chars[char_bytes] = char_idx
                    char_list.append(char_bytes)
                else:
                    # Find closest existing character
                    char_idx = find_closest_char(char_bytes, char_list)
            
            row_indices.append(char_idx)
            # Color RAM format: foreground color in low nibble (0-15)
            # The background is set globally via $D021
            # But we store both for potential Extended Background mode
            row_colors.append(fg_idx)  # Standard hires: color RAM = foreground
            
        screen_map.append(row_indices)
        color_map.append(row_colors)

    print(f"Unique Characters Used: {len(char_list)}")
    print(f"Unique Color Pairs: {len(color_usage)}")
    print(f"Average Error per Cell: {total_error / (chars_wide * chars_high):.1f}")
    
    # Print top color pairs
    sorted_pairs = sorted(color_usage.items(), key=lambda x: -x[1])[:10]
    print("Top 10 color pairs (bg, fg): count")
    for (bg, fg), count in sorted_pairs:
        print(f"  ({bg:2d}, {fg:2d}): {count}")
    
    # 4. Output Generation
    
    # Export Charset Binary
    with open(f"{output_base}_chars.bin", "wb") as f:
        for char_data in char_list:
            f.write(bytes(char_data))
        # Pad remainder of 2KB charset if needed
        padding = (256 - len(char_list)) * 8
        f.write(b'\x00' * padding)

    # Export Screen Map Binary
    with open(f"{output_base}_map.bin", "wb") as f:
        for row in screen_map:
            f.write(bytes(row))
    
    # Export Color Map Binary
    with open(f"{output_base}_colors.bin", "wb") as f:
        for row in color_map:
            f.write(bytes(row))
            
    print(f"Done! Files saved:")
    print(f"  {output_base}_chars.bin  (charset)")
    print(f"  {output_base}_map.bin    (screen map)")
    print(f"  {output_base}_colors.bin (color map)")


def find_closest_char(target_bytes, char_list):
    """Find the closest matching character when we've exceeded 256 unique chars."""
    min_diff = float('inf')
    best_idx = 0
    for idx, existing in enumerate(char_list):
        diff = sum(bin(a ^ b).count('1') for a, b in zip(target_bytes, existing))
        if diff < min_diff:
            min_diff = diff
            best_idx = idx
    return best_idx

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Convert image to C64 charset and map')
    parser.add_argument('image', nargs='?', default='walker.png', help='Input image file')
    parser.add_argument('output', nargs='?', default='walker', help='Output base filename')
    parser.add_argument('--width', type=int, default=80, help='Width in characters')
    parser.add_argument('--height', type=int, default=50, help='Height in characters')
    
    args = parser.parse_args()
    
    generate_c64_artwork(args.image, args.output, args.width, args.height)
