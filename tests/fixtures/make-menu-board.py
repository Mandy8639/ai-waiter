#!/usr/bin/env python3
"""Regenerates tests/fixtures/menu-board.jpg, the menu-reading probe input.

    python3 tests/fixtures/make-menu-board.py

Deliberately NOT a clean render. The real input to menu import is a
photograph taken in a restaurant — off-angle, lit from one side, slightly
out of focus, saved as a lossy JPEG. A model that reads crisp black-on-
white text proves nothing about that, so the degradations below are the
point of the fixture, not decoration.

The ground truth lives in scripts/vet-models-by-job.ts (BOARD_ITEMS) and
must be updated together with this file.

The last line is the trap: "Market price today - ask at counter" has no
price, and a model that returns a number for it fails the probe outright
however fast it was. Inventing a price is the one extraction error a
restaurant cannot catch by reading its own menu back — every other
mistake looks wrong on sight.
"""

from PIL import Image, ImageDraw, ImageFont, ImageFilter

ITEMS = [
    ("STARTERS", None),
    ("Samosa (2 pcs)", "4.99"),
    ("Onion Bhaji", "5.49"),
    ("Chicken 65", "8.95"),
    ("MAINS", None),
    ("Chicken Biryani", "14.50"),
    ("Paneer Butter Masala", "12.99"),
    ("Lamb Rogan Josh", "16.75"),
    ("Dal Tadka", "9.25"),
    ("BREADS", None),
    ("Butter Naan", "3.50"),
    ("Garlic Naan", "4.25"),
    ("Tandoori Roti", "2.99"),
    ("DRINKS", None),
    ("Mango Lassi", "4.50"),
    ("Masala Chai", "2.75"),
    ("Market price today - ask at counter", None),
]

W, H = 900, 1250
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"

img = Image.new("RGB", (W, H), (250, 247, 240))
d = ImageDraw.Draw(img)
title_f = ImageFont.truetype(FONT, 46)
head_f = ImageFont.truetype(FONT, 32)
item_f = ImageFont.truetype(FONT, 26)

d.text((W // 2 - 120, 45), "SPICE HOUSE", font=title_f, fill=(40, 30, 25))
y = 140
for name, price in ITEMS:
    if price is None and name.isupper() and len(name) < 20:
        y += 26
        d.text((70, y), name, font=head_f, fill=(150, 60, 30))
        y += 48
    elif price is None:
        d.text((70, y), name, font=item_f, fill=(90, 85, 80))
        y += 44
    else:
        d.text((70, y), name, font=item_f, fill=(35, 30, 28))
        d.text((W - 160, y), f"${price}", font=item_f, fill=(35, 30, 28))
        y += 44

# Lit from one side, the way a board near a window photographs.
grad = Image.new("L", (W, H))
gd = ImageDraw.Draw(grad)
for x in range(W):
    gd.line([(x, 0), (x, H)], fill=int(200 + 55 * (x / W)))
img = Image.composite(img, Image.new("RGB", (W, H), (225, 220, 210)), grad)

img = img.rotate(-1.4, expand=True, fillcolor=(245, 242, 236))  # handheld
img = img.filter(ImageFilter.GaussianBlur(0.7))                 # imperfect focus
img.save("tests/fixtures/menu-board.jpg", quality=68)           # phone JPEG

print(f"wrote tests/fixtures/menu-board.jpg {img.size}")
