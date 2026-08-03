"""Generate clean MZO text app icons for the PWA."""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
BG = (19, 27, 46, 255)  # #131b2e — matches theme_color
FG = (250, 204, 21, 255)  # bright yellow #facc15

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\calibrib.ttf",
    r"C:\Windows\Fonts\arial.ttf",
]


def pick_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size=size)
    return ImageFont.load_default()


def make_icon(size, path):
    img = Image.new("RGBA", (size, size), BG)
    draw = ImageDraw.Draw(img)
    text = "MZO"

    # Fill most of the icon (~90% width); slight edge padding only
    font_size = int(size * 0.55)
    max_w = int(size * 0.90)
    max_h = int(size * 0.72)

    while font_size > 8:
        font = pick_font(font_size)
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        if tw <= max_w and th <= max_h:
            break
        font_size -= 2

    font = pick_font(font_size)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1]

    draw.text((x, y), text, font=font, fill=FG)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG", optimize=True)
    print(f"wrote {path} ({size}x{size}) font={font_size} text={tw}x{th}")


def main():
    out = os.path.abspath(OUT)
    make_icon(192, os.path.join(out, "icon-192.png"))
    make_icon(512, os.path.join(out, "icon-512.png"))
    print("done")


if __name__ == "__main__":
    main()
