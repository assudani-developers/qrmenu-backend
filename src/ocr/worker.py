#!/usr/bin/env python3
"""Long-lived OCR worker: models load once, then each stdin line {"id","path"} -> one stdout line {"id","result"}."""
import sys, json, os
real_out = sys.stdout
sys.stdout = sys.stderr          # keep library chatter off the protocol channel
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engine

def send(o):
    real_out.write(json.dumps(o, ensure_ascii=False) + "\n"); real_out.flush()

try:
    engine.reader(["en"])  # the Devanagari model loads only when a page has Hindi text
except Exception as e:
    sys.stderr.write(f"[ocr-worker] model preload: {e}\n")
send({"ready": True})
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        req = json.loads(line)
        send({"id": req["id"], "result": engine.parse(req["path"])})
    except Exception as e:
        send({"id": (json.loads(line).get("id") if line.startswith("{") else None), "result": {"success": False, "error": f"OCR failed: {e}"}})
