"""Composite individual face photos into simulated group photos for testing
the pump-site morning/evening attendance capture flow."""
from PIL import Image
import random

FACES = [
    "man_33.jpg", "man_36.jpg", "man_38.jpg",
    "woman_72.jpg", "woman_75.jpg", "woman_83.jpg",
]

THUMB = (150, 150)
GAP = 12
BG = (30, 30, 30)


def make_group(faces, out_path):
    imgs = [Image.open(f).convert("RGB").resize(THUMB) for f in faces]
    n = len(imgs)
    cols = min(n, 4)
    rows = (n + cols - 1) // cols
    w = cols * THUMB[0] + (cols + 1) * GAP
    h = rows * THUMB[1] + (rows + 1) * GAP
    canvas = Image.new("RGB", (w, h), BG)
    for i, img in enumerate(imgs):
        r, c = divmod(i, cols)
        x = GAP + c * (THUMB[0] + GAP)
        y = GAP + r * (THUMB[1] + GAP)
        canvas.paste(img, (x, y))
    canvas.save(out_path, quality=90)
    print(f"wrote {out_path} ({n} faces)")


random.seed(1)
morning = FACES[:]
random.shuffle(morning)
make_group(morning, "group_morning.jpg")

evening = FACES[:5]  # simulate one worker missing (evening-only/absent case)
random.shuffle(evening)
make_group(evening, "group_evening.jpg")
