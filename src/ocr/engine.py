#!/usr/bin/env python3
"""
Offline menu-photo -> structured menu engine (no cloud API).

Pipeline: orientation/scale/deskew/illumination fix  ->  EasyOCR (CRAFT + CRNN, English + Devanagari)
          -> layout analysis (columns, lines, price columns, headings, descriptions)
          -> diet detection from the printed veg / non-veg marks (colour analysis) + keywords
          -> spelling repair against a culinary lexicon.
"""
import os, re, sys, json, math, pathlib, warnings
warnings.filterwarnings("ignore")

_orig_mkdir = pathlib.Path.mkdir  # Python 3.14 + easyocr: tolerate existing dirs
def _safe_mkdir(self, mode=0o777, parents=False, exist_ok=False):
    try: _orig_mkdir(self, mode=mode, parents=parents, exist_ok=exist_ok)
    except FileExistsError:
        if not exist_ok: raise
pathlib.Path.mkdir = _safe_mkdir

import numpy as np, cv2
try:
    import torch
    torch.set_num_threads(max(1, os.cpu_count() or 1))
except Exception:
    pass
cv2.setNumThreads(max(1, os.cpu_count() or 1))
from PIL import Image, ImageOps
from rapidfuzz import process, fuzz

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lexicon import DISHES, SECTIONS, NONVEG, VEGMARK, SPICY, TAG_WORDS  # noqa: E402

DIGIT_DISHES = None
def _digit_dishes():
    global DIGIT_DISHES
    if DIGIT_DISHES is None:
        DIGIT_DISHES = {re.sub(r"\s+", " ", d.lower()) for d in DISHES if re.search(r"\d", d)}
    return DIGIT_DISHES
DEV = re.compile("[\u0904-\u0963\u0970-\u097F]")
DEVDIG = str.maketrans("\u0966\u0967\u0968\u0969\u096a\u096b\u096c\u096d\u096e\u096f", "0123456789")
_READERS = {}

def reader(langs):
    key = ",".join(langs)
    if key not in _READERS:
        import easyocr
        model_dir = os.path.join(HERE, "models")
        _READERS[key] = easyocr.Reader(langs, gpu=False, verbose=False, download_enabled=True,
                                       model_storage_directory=model_dir,
                                       user_network_directory=os.path.join(HERE, "user_network"))
    return _READERS[key]

# ------------------------------------------------------------------ image preparation
def load_image(path):
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    return np.array(im)[:, :, ::-1].copy()

def rescale(img, target=1400):
    h, w = img.shape[:2]
    s = max(0.4, min(2.5, target / max(h, w)))
    if abs(s - 1) < 0.05: return img
    return cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)

def estimate_skew(gray):
    small = cv2.resize(gray, None, fx=0.4, fy=0.4, interpolation=cv2.INTER_AREA)
    bw = cv2.adaptiveThreshold(small, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 25, 15)
    best, best_score = 0.0, -1.0
    hh, ww = bw.shape
    for a in np.arange(-10, 10.01, 0.5):
        M = cv2.getRotationMatrix2D((ww / 2, hh / 2), a, 1)
        r = cv2.warpAffine(bw, M, (ww, hh), flags=cv2.INTER_NEAREST)
        sc = np.var(np.sum(r, axis=1, dtype=np.float64))
        if sc > best_score: best, best_score = a, sc
    return best

def rotate(img, angle, border):
    h, w = img.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1)
    return cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=border)

def prepare(path):
    color = rescale(load_image(path))
    gray = cv2.cvtColor(color, cv2.COLOR_BGR2GRAY)
    if np.mean(gray) < 100:  # light text on dark background -> invert for the recogniser
        gray = 255 - gray
    ang = estimate_skew(gray)
    if 0.4 <= abs(ang) <= 10:
        color = rotate(color, ang, (255, 255, 255))
        gray = rotate(gray, ang, 255)
    bg = cv2.GaussianBlur(gray, (0, 0), max(gray.shape) / 25)           # flatten shadows / uneven light
    norm = cv2.divide(gray, np.maximum(bg, 1), scale=255)
    norm = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(norm)
    plain = cv2.divide(gray, np.maximum(bg, 1), scale=255)
    norm = cv2.fastNlMeansDenoising(norm, None, 7, 7, 21)
    return color, norm, plain

# ------------------------------------------------------------------ OCR
class Tok:
    __slots__ = ("t", "x0", "y0", "x1", "y1", "conf")
    def __init__(self, t, x0, y0, x1, y1, conf): self.t, self.x0, self.y0, self.x1, self.y1, self.conf = t, x0, y0, x1, y1, conf
    @property
    def cy(self): return (self.y0 + self.y1) / 2
    @property
    def cx(self): return (self.x0 + self.x1) / 2
    @property
    def h(self): return max(1.0, self.y1 - self.y0)

def _tok(box, text, conf):
    xs, ys = [p[0] for p in box], [p[1] for p in box]
    text = text.strip().translate(DEVDIG) if not DEV.search(text) else text.strip()
    return Tok(text, min(xs), min(ys), max(xs), max(ys), float(conf)) if text else None

DET_SIDE = int(os.environ.get("OCR_DET_SIDE", "1100"))   # detector works on a smaller copy: ~2x faster, same boxes
WEAK = 0.45                                               # English read below this -> try the Devanagari model

def _read(img, langs, mag):
    """Detect text boxes once, read them with the fast English model, and send only the boxes it could not
    read (Hindi / Devanagari words) to the slower Devanagari model. ~4x faster than reading every box twice."""
    en = reader(["en"])
    s = min(1.0, DET_SIDE / max(img.shape[:2])) * mag
    h, f = en.detect(img, canvas_size=2560, mag_ratio=s, text_threshold=0.6, low_text=0.3, link_threshold=0.4,
                     width_ths=0.6, add_margin=0.08)
    h, f = h[0], f[0]
    if not h and not f: return []
    res = en.recognize(img, h, f, batch_size=16, contrast_ths=0.1, adjust_contrast=0.5)
    out = []
    weak = []
    for box, text, conf in res:
        if "hi" in langs and (conf < WEAK or not re.search(r"[A-Za-z0-9]", text)): weak.append((box, text, conf))
        else:
            t = _tok(box, text, conf)
            if t: out.append(t)
    if weak:
        hl = [[int(min(p[0] for p in b)), int(max(p[0] for p in b)), int(min(p[1] for p in b)), int(max(p[1] for p in b))] for b, _, _ in weak]
        hi = reader(["en", "hi"]).recognize(img, hl, [], batch_size=16, contrast_ths=0.1, adjust_contrast=0.5)
        for (b, t0, c0), (b1, t1, c1) in zip(weak, hi):
            t = _tok(b, t1, c1) if (c1 > c0 + 0.05 and DEV.search(t1)) or c1 > c0 + 0.2 else _tok(b, t0, c0)
            if t: out.append(t)
    return out

def run_ocr(gray, plain):
    """One detection pass, English first, Devanagari only where needed; a second pass on the plain image if little was found."""
    toks = _read(gray, ["en", "hi"], 1.0)
    if len(toks) < 8:
        b = _read(plain, ["en", "hi"], 1.0)
        for t in b:
            hit = next((o for o in toks if _iou(t, o) > 0.45), None)
            if hit is None: toks.append(t)
            elif t.conf > hit.conf + 0.05: toks[toks.index(hit)] = t
    return toks

def _iou(a, b):
    ix = max(0, min(a.x1, b.x1) - max(a.x0, b.x0)); iy = max(0, min(a.y1, b.y1) - max(a.y0, b.y0))
    inter = ix * iy
    return inter / max(1.0, (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter)

# ------------------------------------------------------------------ prices
CUR = re.compile(r"^(?:₹|rs\.?|inr|r\$)\s*", re.I)
def as_price(s):
    """'₹320', '320/-', 'Rs. 3O0', '99.50' -> float, else None."""
    s = s.strip().replace(" ", "")
    s = CUR.sub("", s)
    s = re.sub(r"^[TXZz?¥]+(?=\d{2,4}$)", "", s)
    s = re.sub(r"(/-|-|\.)$", "", s)
    if not re.fullmatch(r"[0-9OolIS|B]{2,5}(?:\.\d{1,2})?", s): return None
    digits = sum(c.isdigit() for c in s)
    if digits < math.ceil(len(s.split(".")[0]) / 2): return None
    s = s.translate(str.maketrans("OolI|SB", "0011158"))
    try: v = float(s)
    except ValueError: return None
    return v if 10 <= v <= 9999 else None

def split_prices(tok):
    """Return (text_part, [prices]) for a token that may be 'Dal Fry 180' or '120/220'."""
    t = tok.t.strip()
    parts = [p for p in re.split(r"\s*[/|]\s*(?=\d)", t) if p]
    if len(parts) > 1 and all(as_price(p) for p in parts): return "", [as_price(p) for p in parts]
    p = as_price(t)
    if p and t not in ("65", "555"): return "", [p]
    m = re.match(r"^(.*\D)[\s.·…_\-]*((?:₹|rs\.?\s*)?[0-9OolS]{2,4}(?:\.\d{1,2})?(?:\s*/-)?)$", t, re.I)
    if m and (m.group(1).strip().lower() + " " + m.group(2).strip()) in _digit_dishes(): return t, []   # "Chicken 65"
    if m and len(m.group(1).strip()) >= 3 and as_price(m.group(2)):
        return m.group(1).strip(" .·…_-"), [as_price(m.group(2))]
    m = re.match(r"^(.*\D)\s+(\d{2,4})\s*[/|]\s*(\d{2,4})$", t)
    if m and as_price(m.group(2)) and as_price(m.group(3)):
        return m.group(1).strip(), [as_price(m.group(2)), as_price(m.group(3))]
    return t, []

# ------------------------------------------------------------------ layout
class Line:
    def __init__(self, toks):
        toks = sorted(toks, key=lambda k: k.x0)
        merged = []
        for k in toks:
            if merged and as_price(k.t) and (merged[-1].t.lower() + " " + k.t.strip()) in _digit_dishes() and k.x0 - merged[-1].x1 < 2.2 * k.h:
                m = merged[-1]; merged[-1] = Tok(m.t + " " + k.t.strip(), m.x0, min(m.y0, k.y0), k.x1, max(m.y1, k.y1), min(m.conf, k.conf))
            else: merged.append(k)
        toks = merged
        self.toks = toks
        self.y0 = min(k.y0 for k in toks); self.y1 = max(k.y1 for k in toks)
        self.h = float(np.median([k.h for k in toks]))
        self.conf = float(np.mean([k.conf for k in toks]))
        self.text, self.prices = "", []
        for k in self.toks:
            tx, pr = split_prices(k)
            if pr and self.text.strip() == "" and tx == "" and len(self.toks) > 1 and k is self.toks[0] and as_price(k.t) and len(k.t) <= 3:
                continue  # leading item number such as "12" — not a price
            self.prices += pr
            if tx: self.text += (" " if self.text else "") + tx
        self.text = re.sub(r"\s+", " ", self.text).strip()
    @property
    def x0(self): return self.toks[0].x0
    @property
    def x1(self): return max(k.x1 for k in self.toks)

def group_lines(toks):
    toks = sorted(toks, key=lambda k: k.cy)
    rows = []
    for k in toks:
        if rows:
            r = rows[-1]
            cy = np.mean([x.cy for x in r]); hh = np.median([x.h for x in r])
            if abs(k.cy - cy) <= 0.55 * min(hh, k.h) + 2: r.append(k); continue
        rows.append([k])
    return [Line(r) for r in rows]

def split_columns(toks, width):
    """Detect a 2-3 column page: a vertical white gap with real *names* on both sides (not just a price column)."""
    names = [t for t in toks if not as_price(t.t) and not split_prices(t)[1]]
    if len(names) < 8: return [toks]
    bins = np.zeros(200)
    for t in toks:
        bins[int(max(0, t.x0) / width * 199): int(min(width - 1, t.x1) / width * 199) + 1] += 1
    empty = bins == 0
    best, i = None, 0
    while i < 200:
        if empty[i]:
            j = i
            while j < 200 and empty[j]: j += 1
            if 0.2 * 200 < i and j < 0.8 * 200 and (j - i) >= 0.035 * 200:
                cut = (i + j) / 2 / 199 * width
                L = [t for t in names if t.cx < cut]; R = [t for t in names if t.cx >= cut]
                prs = [t for t in toks if t.cx >= cut and (as_price(t.t) or split_prices(t)[1]) and not split_prices(t)[0]]
                orphan = sum(1 for p in prs if not any(abs(n.cy - p.cy) < 0.6 * p.h and n.cx >= cut and n.x1 < p.x0 for n in R))
                if len(L) >= 4 and len(R) >= 4 and orphan <= 0.3 * max(1, len(prs)) and (best is None or (j - i) > best[0]): best = (j - i, cut)
            i = j
        else: i += 1
    if not best: return [toks]
    cut = best[1]
    return [[t for t in toks if t.cx < cut], [t for t in toks if t.cx >= cut]]

SEC_L = [s.lower() for s in SECTIONS]
def section_match(text):
    t = re.sub(r"[^a-z&' \-]", "", text.lower()).strip()
    if not t: return None
    m = process.extractOne(t, SEC_L, scorer=fuzz.ratio)
    return (m[0], m[1]) if m and m[1] >= 86 else None

def titlecase(s):
    def fix(w):
        if len(w) <= 2 and w.isupper() and w.lower() not in ("of", "or", "in", "to", "ka", "ki", "ke"): return w
        return w.capitalize() if w.isupper() or w.islower() else w
    out = " ".join(fix(w) for w in s.split())
    return re.sub(r"\b(And|Or|Of|With|In|Ka|Ki|Ke|Di|Da)\b", lambda m: m.group(1).lower() if m.start() else m.group(1), out)

def heading_score(ln, med_h, col_cx, col_w):
    t = ln.text
    letters = [c for c in t if c.isalpha()]
    if len(letters) < 3 or ln.prices: return -9
    sc = 0
    if sum(c.isupper() for c in letters) / len(letters) >= 0.8 and not DEV.search(t): sc += 2
    if section_match(t): sc += 3
    if ln.h >= 1.25 * med_h: sc += 2
    if abs((ln.x0 + ln.x1) / 2 - col_cx) < 0.12 * col_w and (ln.x1 - ln.x0) < 0.7 * col_w: sc += 1
    words = t.split()
    if len(words) <= 4: sc += 1
    if t.rstrip().endswith(":"): sc += 1
    if len(words) > 6 or (t[:1].islower() and len(words) > 2): sc -= 3
    return sc

def clean_name(s):
    s = re.sub(r"^[\s\-–—•·*oO0▪■□●○◦▶►►|]+(?=[A-Za-zऀ-ॿ])", "", s)
    s = re.sub(r"^\d{1,3}[.)\-]\s*", "", s)
    s = re.sub(r"[\s.·…_\-:]+$", "", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()

DISH_L = [d.lower() for d in DISHES]
VOCAB = sorted({w for d in DISH_L for w in re.findall(r"[a-z]{4,}", d)})
def repair(name):
    """Fix OCR spelling using the culinary lexicon; returns (name, matched_exact)."""
    if DEV.search(name): return name, False
    low = re.sub(r"[^a-z0-9&' ]", "", name.lower()).strip()
    if len(low) < 4: return name, False
    m = process.extractOne(low, DISH_L, scorer=fuzz.ratio)
    if m and (m[1] >= 92 or (len(low) >= 9 and m[1] >= 80 and m[1] - (process.extract(low, DISH_L, scorer=fuzz.ratio, limit=2)[1][1]) >= 3)): return DISHES[m[2]], True
    out = []
    for w in name.split():
        lw = re.sub(r"[^a-z]", "", w.lower())
        if len(lw) >= 5 and lw not in VOCAB:
            mm = process.extractOne(lw, VOCAB, scorer=fuzz.ratio)
            if mm and mm[1] >= 85:
                rep = mm[0]
                w = rep.upper() if w.isupper() else rep.capitalize()
        out.append(w)
    fixed = " ".join(out)
    m2 = process.extractOne(re.sub(r"[^a-z0-9&' ]", "", fixed.lower()), DISH_L, scorer=fuzz.ratio)
    if m2 and m2[1] >= 94: return DISHES[m2[2]], True
    return fixed, False

# ------------------------------------------------------------------ diet by printed mark colour
def mark_diet(color, ln):
    h = ln.h
    x0 = int(max(0, ln.x0 - 3.4 * h)); x1 = int(max(0, ln.x0 - 0.15 * h))
    y0 = int(max(0, ln.y0 - 0.25 * h)); y1 = int(min(color.shape[0], ln.y1 + 0.25 * h))
    if x1 - x0 < 4 or y1 - y0 < 4: return None
    hsv = cv2.cvtColor(color[y0:y1, x0:x1], cv2.COLOR_BGR2HSV)
    H, S, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    green = np.sum((H >= 35) & (H <= 90) & (S > 70) & (V > 60))
    red = np.sum(((H <= 12) | (H >= 165)) & (S > 90) & (V > 60))
    need = max(12, 0.02 * h * h)
    if green > need and green > 1.5 * red: return True
    if red > need and red > 1.5 * green: return False
    return None

def keyword_diet(name, desc, section_diet):
    words = set(re.findall(r"[a-z]+", (name + " " + desc).lower()))
    if words & NONVEG and not (words & {"paneer", "veg", "soya", "mushroom"} and "kebab" in words and not words & {"chicken", "mutton", "fish", "lamb"}):
        return False
    if section_diet is not None: return section_diet
    return True

# ------------------------------------------------------------------ parser
PORTION_WORDS = {"half": "Half", "full": "Full", "qtr": "Quarter", "quarter": "Quarter", "small": "Small", "medium": "Medium", "large": "Large",
                 "regular": "Regular", "reg": "Regular", "mini": "Mini", "s": "Small", "m": "Medium", "l": "Large"}

def portion_header(text):
    ws = re.findall(r"[a-z]+", text.lower())
    labs = [PORTION_WORDS[w] for w in ws if w in PORTION_WORDS]
    return labs if len(labs) >= 2 and len(labs) >= len(ws) - 1 else None

def parse_column(toks, color, width, state):
    lines = group_lines(toks)
    lines = [l for l in lines if l.text or l.prices]
    if not lines: return
    dish_hs = [l.h for l in lines if l.prices and l.text] or [l.h for l in lines]
    med_h = float(np.median(dish_hs))
    col_cx = (min(l.x0 for l in lines) + max(l.x1 for l in lines)) / 2
    col_w = max(1.0, max(l.x1 for l in lines) - min(l.x0 for l in lines))
    labels = None
    prev = None                 # last dish dict
    prev_kind = None
    for ln in lines:
        txt = ln.text
        if not txt and ln.prices:                       # price-only line: belongs to previous nameless-price dish
            if prev is not None and not prev["prices"]: prev["prices"] = ln.prices; prev["conf"].append(ln.conf)
            continue
        ph = portion_header(txt)
        if ph and not ln.prices or (ph and ln.prices and len(ln.prices) == len(ph) and len(txt.split()) <= 4 and False):
            labels = ph; continue
        hs = heading_score(ln, med_h, col_cx, col_w)
        looks_desc = prev is not None and prev_kind in ("dish", "desc") and (
            ln.h < 0.93 * prev["h"] or txt[:1].islower() or txt.count(",") >= 1 or len(txt.split()) > 5
            # a price-less line right under a priced dish, no bigger than it and not a known dish name = its description
            or (prev["prices"] and ln.h <= 1.08 * prev["h"] and len(txt.split()) >= 2 and not repair(clean_name(txt))[1])) and hs < 4 and not ln.prices
        if ln.prices and txt:
            nm = clean_name(txt)
            if len(nm) < 2: continue
            d = dict(name=nm, prices=ln.prices, h=ln.h, desc="", conf=[ln.conf], ln=ln, cat=state["cat"], labels=labels, diet=mark_diet(color, ln), sdiet=state["sdiet"])
            state["dishes"].append(d); prev, prev_kind = d, "dish"
        elif hs >= 3 and not looks_desc:
            sec = section_match(txt)
            state["cat"] = titlecase(sec[0] if sec and sec[1] >= 94 else re.sub(r"[:\s]+$", "", txt))
            low = txt.lower()
            state["sdiet"] = False if re.search(r"non[\s\-]?veg", low) else (True if re.search(r"\bveg(etarian)?\b", low) else None)
            labels = None; prev, prev_kind = None, "head"
            if state["first_head_y"] is None: state["first_head_y"] = ln.y0
        elif looks_desc:
            prev["desc"] = (prev["desc"] + " " + txt).strip(); prev["conf"].append(ln.conf); prev_kind = "desc"
        else:                                           # name without price on this line (price may follow / column-less)
            nm = clean_name(txt)
            if len(nm) >= 3:
                d = dict(name=nm, prices=[], h=ln.h, desc="", conf=[ln.conf], ln=ln, cat=state["cat"], labels=labels, diet=mark_diet(color, ln), sdiet=state["sdiet"])
                state["dishes"].append(d); prev, prev_kind = d, "dish"

def parse(path):
    color, gray, plain = prepare(path)
    toks = [t for t in run_ocr(gray, plain) if t.conf >= 0.2 and len(t.t.strip()) >= 1]
    h, w = gray.shape[:2]
    state = dict(cat="Menu", sdiet=None, dishes=[], first_head_y=None)
    cols = split_columns(toks, w)
    cols.sort(key=lambda c: min((t.x0 for t in c), default=0))
    for c in cols:
        state["cat"], state["sdiet"] = "Menu" if len(cols) == 1 else state["cat"], None
        parse_column(c, color, w, state)

    cats, order, warnings_ = {}, [], []
    seen = set()
    for d in state["dishes"]:
        name, exact = repair(d["name"])
        name = titlecase(name) if name.isupper() else name
        key = (d["cat"], name.lower())
        if key in seen: continue
        seen.add(key)
        prices = sorted(set(d["prices"]))
        base = prices[0] if prices else 0
        variants = []
        if len(prices) >= 2:
            labs = d["labels"] if d["labels"] and len(d["labels"]) == len(prices) else \
                   (["Half", "Full"] if len(prices) == 2 else ["Small", "Medium", "Large"][:len(prices)] if len(prices) == 3 else [f"Option {i+1}" for i in range(len(prices))])
            variants = [{"name": l, "price": p} for l, p in zip(labs, prices)]
        desc = d["desc"]
        diet = d["diet"] if d["diet"] is not None else keyword_diet(name, desc, d["sdiet"])
        low = (name + " " + desc).lower()
        spice = "spicy" if set(re.findall(r"[a-z]+", low)) & SPICY and "masala" not in low.split()[:1] and any(w in low for w in ("spicy", "schezwan", "chilli", "chili", "peri", "angara", "andhra", "kolhapuri")) else "none"
        tags = [t for t, ks in TAG_WORDS.items() if any(k in low for k in ks)]
        conf = round(float(np.mean(d["conf"])) * (1.0 if exact else 0.97), 2)
        item = dict(name=name, price=base, description=desc, isVeg=bool(diet), spiceLevel=spice, tags=tags, variants=variants, confidence=conf)
        if d["cat"] not in cats: cats[d["cat"]] = []; order.append(d["cat"])
        cats[d["cat"]].append(item)
        if not base: warnings_.append(f"Price not found for “{name}” — please add it.")
        elif conf < 0.5 and not exact: warnings_.append(f"Please verify “{name}” (hard to read).")

    rest_name = ""
    glines = group_lines(toks)
    if glines:
        med = float(np.median([l.h for l in glines]))
        cand = [l for l in glines if l.y1 < 0.2 * h and not l.prices and len(re.sub(r"[^A-Za-z\u0900-\u097F]", "", l.text)) >= 4
                and not (section_match(l.text) and section_match(l.text)[1] >= 90) and l.h >= 1.15 * med]
        if cand:
            top = max(cand, key=lambda l: l.h)
            rest_name = titlecase(top.text) if top.text.isupper() else top.text
    categories = [{"name": c, "items": cats[c]} for c in order if cats[c]]
    total = sum(len(c["items"]) for c in categories)
    if total == 0:
        return dict(success=False, error="No dishes could be read. Use a clear, straight, well-lit photo of each menu page.", rawText="\n".join(l.text for l in group_lines(toks)))
    return dict(success=True, engine="local-ocr", restaurantName=rest_name, categories=categories, totalItems=total, warnings=warnings_[:25],
                rawText="\n".join(l.text + ("  " + " / ".join(str(int(p)) for p in l.prices) if l.prices else "") for l in group_lines(toks)))

if __name__ == "__main__":
    out = parse(sys.argv[1])
    sys.stdout.write(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
