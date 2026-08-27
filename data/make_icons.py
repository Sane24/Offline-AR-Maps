#!/usr/bin/env python3
"""Generate PWA icons: charcoal tile with the cairn mark (three stacked stones)."""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

BG = (20, 22, 15)
ORANGE = (224, 100, 30)

# cairn stones in a 24x24 design space: (x, y, w, h)
STONES = [
    (8.6, 3.4, 6.8, 4.6),
    (6.6, 9.7, 10.8, 4.6),
    (4.6, 16.0, 14.8, 4.6),
]


def draw_icon(size, pad_frac=0.0, rounded=True):
    s = 4  # supersample
    W = size * s
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if rounded:
        d.rounded_rectangle([0, 0, W - 1, W - 1], radius=W * 0.22, fill=BG + (255,))
    else:
        d.rectangle([0, 0, W - 1, W - 1], fill=BG + (255,))

    # the mark occupies the middle of the tile
    content = W * (1 - 2 * pad_frac)
    mark = content * 0.62
    ox = (W - mark) / 2
    oy = (W - mark) / 2
    k = mark / 24.0
    for (x, y, w, h) in STONES:
        d.rounded_rectangle(
            [ox + x * k, oy + y * k, ox + (x + w) * k, oy + (y + h) * k],
            radius=h * k / 2,
            fill=ORANGE + (255,),
        )

    return img.resize((size, size), Image.LANCZOS)


def main():
    draw_icon(192).save(OUT / "icon-192.png")
    draw_icon(512).save(OUT / "icon-512.png")
    draw_icon(180).save(OUT / "icon-180.png")
    # maskable: full-bleed square with extra safe-area padding
    draw_icon(512, pad_frac=0.12, rounded=False).save(OUT / "icon-maskable-512.png")
    print(f"icons written to {OUT}")


if __name__ == "__main__":
    main()
