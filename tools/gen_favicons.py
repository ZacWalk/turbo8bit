"""Generate sized favicons and a social (Open Graph) image from web/static/favicon.png.

The source image's pixel (0,0) is treated as the canonical brand background color,
so social images are padded with that color to produce a 1200x630 OG image.
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web" / "static" / "favicon.png"
OUT_DIR = ROOT / "web" / "static" / "icons"
OUT_DIR.mkdir(parents=True, exist_ok=True)

ICON_SIZES = [16, 32, 48, 180, 192, 256, 512]
OG_SIZE = (1200, 630)


def main() -> None:
    img = Image.open(SRC).convert("RGBA")
    bg = img.getpixel((0, 0))
    print(f"Source: {img.size} mode=RGBA bg(0,0)={bg}")

    # Square icons.
    for size in ICON_SIZES:
        resized = img.copy()
        resized.thumbnail((size, size), Image.LANCZOS)
        canvas = Image.new("RGBA", (size, size), bg)
        x = (size - resized.width) // 2
        y = (size - resized.height) // 2
        canvas.paste(resized, (x, y), resized)
        out = OUT_DIR / f"favicon-{size}.png"
        canvas.convert("RGB").save(out, optimize=True)
        print(f"  wrote {out.relative_to(ROOT)}")

    # Multi-size .ico for legacy browsers.
    ico_sizes = [(s, s) for s in (16, 32, 48)]
    ico_path = OUT_DIR / "favicon.ico"
    img.save(ico_path, sizes=ico_sizes)
    print(f"  wrote {ico_path.relative_to(ROOT)}")

    # Open Graph / social card.
    og = Image.new("RGBA", OG_SIZE, bg)
    fit = img.copy()
    target_h = int(OG_SIZE[1] * 0.9)
    ratio = target_h / fit.height
    target_w = int(fit.width * ratio)
    fit = fit.resize((target_w, target_h), Image.LANCZOS)
    x = (OG_SIZE[0] - target_w) // 2
    y = (OG_SIZE[1] - target_h) // 2
    og.paste(fit, (x, y), fit)
    og_path = OUT_DIR / "og-image.png"
    og.convert("RGB").save(og_path, optimize=True)
    print(f"  wrote {og_path.relative_to(ROOT)}")

    hex_bg = "#{:02X}{:02X}{:02X}".format(bg[0], bg[1], bg[2])
    print(f"Brand background color (CSS): {hex_bg}")


if __name__ == "__main__":
    main()
