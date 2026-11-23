"""Generates synthetic menu photos (clean + degraded) with ground truth, to measure OCR accuracy."""
import json, random, os
import numpy as np, cv2
from PIL import Image, ImageDraw, ImageFont

F = "/System/Library/Fonts/Supplemental/"
def font(n, s): return ImageFont.truetype(F + n, s)
random.seed(7)

MENU = {
  "Starters": [("Paneer Tikka", 260, True, "Charred cottage cheese, mint chutney"), ("Chicken 65", 290, False, "Crispy curry leaf fried chicken"), ("Hara Bhara Kebab", 220, True, ""), ("Veg Spring Rolls", 180, True, "")],
  "Main Course": [("Butter Chicken", (220, 380), False, "Creamy tomato gravy"), ("Dal Makhani", 280, True, "Slow cooked black lentils"), ("Kadai Paneer", 310, True, ""), ("Mutton Rogan Josh", 460, False, "Kashmiri style")],
  "Breads": [("Butter Naan", 70, True, ""), ("Garlic Naan", 80, True, ""), ("Tandoori Roti", 30, True, "")],
  "Desserts": [("Gulab Jamun", 120, True, "Two pieces"), ("Rasmalai", 150, True, "")],
}

def mark(d, x, y, veg, s):
    c = (22, 163, 74) if veg else (200, 30, 30)
    d.rectangle([x, y, x + s, y + s], outline=c, width=2)
    if veg: d.ellipse([x + s * .3, y + s * .3, x + s * .7, y + s * .7], fill=c)
    else: d.polygon([(x + s / 2, y + s * .25), (x + s * .25, y + s * .75), (x + s * .75, y + s * .75)], fill=c)

def single(path, dots=True, leader=False, W=1100):
    im = Image.new("RGB", (W, 1500), (252, 250, 245)); d = ImageDraw.Draw(im)
    d.text((W // 2, 50), "SPICE SYMPHONY", font=font("Georgia Bold.ttf", 46), fill=(40, 20, 10), anchor="mm")
    y = 120
    for cat, items in MENU.items():
        d.text((W // 2, y), cat.upper(), font=font("Georgia Bold.ttf", 34), fill=(150, 80, 10), anchor="mm"); y += 70
        for n, p, v, desc in items:
            if dots: mark(d, 60, y + 4, v, 20)
            d.text((100, y), n, font=font("Arial.ttf", 28), fill=(20, 20, 20))
            ptxt = f"{p[0]} / {p[1]}" if isinstance(p, tuple) else str(p)
            if leader: d.text((100 + d.textlength(n, font=font("Arial.ttf", 28)) + 20, y), "." * 18 + " " + ptxt, font=font("Arial.ttf", 28), fill=(20, 20, 20))
            else: d.text((W - 80, y), ptxt, font=font("Arial.ttf", 28), fill=(20, 20, 20), anchor="ra")
            y += 40
            if desc: d.text((100, y - 2), desc, font=font("Arial Italic.ttf", 21), fill=(110, 110, 110)); y += 34
            y += 14
        y += 30
    im.crop((0, 0, W, y)).save(path)

def two_col(path, W=1500):
    im = Image.new("RGB", (W, 1100), (250, 246, 238)); d = ImageDraw.Draw(im)
    cats = list(MENU.items()); halves = [cats[:2], cats[2:]]
    for ci, half in enumerate(halves):
        x0 = 60 + ci * 740; y = 60
        for cat, items in half:
            d.text((x0, y), cat.upper(), font=font("Georgia Bold.ttf", 34), fill=(150, 80, 10)); y += 64
            for n, p, v, desc in items:
                ptxt = f"{p[0]}/{p[1]}" if isinstance(p, tuple) else str(p)
                mark(d, x0, y + 4, v, 20)
                d.text((x0 + 40, y), n, font=font("Arial.ttf", 27), fill=(20, 20, 20))
                d.text((x0 + 640, y), ptxt, font=font("Arial.ttf", 27), fill=(20, 20, 20), anchor="ra"); y += 40
                if desc: d.text((x0 + 40, y - 2), desc, font=font("Arial Italic.ttf", 20), fill=(110, 110, 110)); y += 32
                y += 12
            y += 30
    im.save(path)

def degrade(src, dst, angle=3.5, blur=1.1, noise=9, seed=1, scale=0.62, q=55):
    rng = np.random.default_rng(seed)
    img = cv2.imread(src); h, w = img.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1)
    img = cv2.warpAffine(img, M, (w, h), borderValue=(235, 235, 235))
    img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    img = cv2.GaussianBlur(img, (0, 0), blur)
    h, w = img.shape[:2]
    grad = np.linspace(0.72, 1.05, w)[None, :, None]            # uneven lighting / shadow
    img = np.clip(img * grad + rng.normal(0, noise, img.shape), 0, 255).astype(np.uint8)
    cv2.imwrite(dst, img, [cv2.IMWRITE_JPEG_QUALITY, q])

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__)); out = os.path.join(here, "synthetic"); os.makedirs(out, exist_ok=True)
    single(f"{out}/a_single_dots.png"); single(f"{out}/c_leaders.png", dots=False, leader=True); two_col(f"{out}/b_two_col.png")
    degrade(f"{out}/a_single_dots.png", f"{out}/d_photo_a.jpg", scale=0.85, blur=0.8, noise=6, q=75); degrade(f"{out}/b_two_col.png", f"{out}/e_photo_b.jpg", angle=-2.5, blur=1.3, seed=3)
    truth = [{"category": c, "name": n, "price": (p[0] if isinstance(p, tuple) else p), "veg": v} for c, items in MENU.items() for n, p, v, _ in items]
    json.dump(truth, open(f"{out}/truth.json", "w"), indent=1)
    print("generated", len(truth), "dishes")
