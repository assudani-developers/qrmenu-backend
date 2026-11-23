"""python3 eval_ocr.py  -> accuracy of the OCR engine on synthetic menus."""
import json, os, sys, subprocess
from rapidfuzz import fuzz
here = os.path.dirname(os.path.abspath(__file__)); syn = os.path.join(here, "synthetic")
truth = json.load(open(f"{syn}/truth.json"))
tot = dict(items=0, found=0, price=0, veg=0, cat=0)
for f in sorted(os.listdir(syn)):
    if not f.endswith((".png", ".jpg")): continue
    out = subprocess.run([sys.executable, os.path.join(here, "../src/ocr/engine.py"), f"{syn}/{f}"], capture_output=True, text=True).stdout
    d = json.loads(out[out.index("{"):])
    got = [(c["name"], i) for c in d.get("categories", []) for i in c["items"]]
    s = dict(found=0, price=0, veg=0, cat=0)
    for t in truth:
        best = max(got, key=lambda g: fuzz.ratio(g[1]["name"].lower(), t["name"].lower()), default=None)
        if not best or fuzz.ratio(best[1]["name"].lower(), t["name"].lower()) < 82: print("  MISSING", f, t["name"]); continue
        s["found"] += 1
        s["price"] += best[1]["price"] == t["price"]
        if best[1]["price"] != t["price"]: print("  PRICE", f, t["name"], best[1]["price"], "!=", t["price"])
        s["veg"] += best[1]["isVeg"] == t["veg"]
        s["cat"] += fuzz.ratio(best[0].lower(), t["category"].lower()) >= 80
    n = len(truth); print(f"{f:18} found {s['found']}/{n}  price {s['price']}/{n}  diet {s['veg']}/{n}  category {s['cat']}/{n}  extras {len(got) - s['found']}")
    for k in s: tot[k] += s[k]; tot["items"] += (k == "found") * n
print("TOTAL  found %.0f%%  price %.0f%%  diet %.0f%%  category %.0f%%" % tuple(100 * tot[k] / tot["items"] for k in ("found", "price", "veg", "cat")))
