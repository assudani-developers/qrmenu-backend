/**
 * Photo -> menu, fully offline, two engines:
 *  - main: a persistent Python worker (src/ocr/worker.py, EasyOCR) — most accurate, needs Python + models;
 *  - backup: Tesseract in Node (services/ocrLite.js) — always available, used when Python is missing,
 *    still loading, or fails on a page. So a scan never waits minutes for an engine that cannot start.
 * OCR_ENGINE=auto (default) | python | lite.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PY = process.env.PYTHON_BIN || 'python3';
const WORKER = path.join(__dirname, '../ocr/worker.py');
const TIMEOUT_MS = 90000;
const ENGINE = (process.env.OCR_ENGINE || 'auto').toLowerCase();
const lite = require('./ocrLite');
const MODELS = path.join(__dirname, '../ocr/models');

/** Is the Python engine usable here? Checked once (packages import + model files present); never blocks a scan for long. */
let pyOk = null, pyCheck = null, pyWhy = '';
function pythonAvailable() {
  if (ENGINE === 'lite') return Promise.resolve(false);
  if (pyOk !== null) return Promise.resolve(pyOk);
  if (pyCheck) return pyCheck;
  pyCheck = new Promise((resolve) => {
    const need = ['craft_mlt_25k.pth', 'english_g2.pth'];
    if (!need.every((f) => fs.existsSync(path.join(MODELS, f)))) { pyWhy = 'OCR model files missing in src/ocr/models'; return resolve(false); }
    let done = false, err = '';
    const p = spawn(PY, ['-c', 'import easyocr, cv2, numpy, PIL, rapidfuzz'], { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch (_) {} pyWhy = 'python import timed out'; resolve(false); } }, 25000);
    p.on('error', (e) => { if (!done) { done = true; clearTimeout(t); pyWhy = e.message; resolve(false); } });
    p.on('exit', (code) => { if (!done) { done = true; clearTimeout(t); pyWhy = code ? err.trim().split('\n').pop() : ''; resolve(code === 0); } });
  }).then((ok) => { pyOk = ok; pyCheck = null; console.log(`[OCR] main engine ${ok ? 'available' : `not available (${pyWhy}); using the built-in backup engine`}`); return ok; });
  return pyCheck;
}
// The OCR models use ~1 GB of RAM. Free the memory when nobody has scanned for a while (default 10 min);
// the next scan starts the engine again in a few seconds. Set OCR_IDLE_MS=0 to keep it always loaded.
const IDLE_MS = Number(process.env.OCR_IDLE_MS ?? 10 * 60 * 1000);
let idleTimer = null;
function touch() {
  clearTimeout(idleTimer);
  if (!IDLE_MS) return;
  idleTimer = setTimeout(() => { if (proc && !pending.size) { try { proc.kill(); } catch (_) {} } }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

let proc = null, ready = null, buf = '', seq = 0, errTail = '';
const pending = new Map();

function start() {
  if (ready) return ready;
  proc = spawn(PY, [WORKER], { stdio: ['pipe', 'pipe', 'pipe'] });
  ready = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('OCR engine took too long to start')), 60000);
    proc.once('exit', (code) => { clearTimeout(to); reject(new Error(`OCR engine stopped while starting (${code}): ${errTail.trim().split('\n').pop() || 'no details'}`)); });
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.ready) { clearTimeout(to); resolve(); }
        else if (pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
      }
    });
    proc.on('error', (e) => { clearTimeout(to); reject(e); });
  });
  const reset = () => { for (const f of pending.values()) f({ success: false, error: 'OCR engine stopped' }); pending.clear(); proc = null; ready = null; buf = ''; };
  proc.on('exit', reset);
  proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
  ready.catch(() => { try { proc && proc.kill(); } catch (_) {} reset(); });
  return ready;
}

/** Load the models in the background. Called when an owner opens the scan screen, so they are ready by the
 *  time the photos are taken. At boot only when OCR_PRELOAD=1 (keeps RAM free on small servers). */
function warm() {
  pythonAvailable().then((ok) => {
    if (!ok) return lite.warm();
    touch(); start().catch((e) => { console.error('[OCR] warmup failed:', e.message); pyOk = false; pyWhy = e.message; lite.warm(); });
  });
}
function warmup() { pythonAvailable(); if (process.env.OCR_PRELOAD === '1') warm(); }

async function ocrFile(file) {
  touch();
  await start();
  const id = ++seq;
  return new Promise((resolve) => {
    const t = setTimeout(() => { pending.delete(id); resolve({ success: false, error: 'Reading took too long. Try a smaller or clearer photo.' }); }, TIMEOUT_MS);
    pending.set(id, (r) => { clearTimeout(t); touch(); resolve(r); });
    proc.stdin.write(JSON.stringify({ id, path: file }) + '\n');
  });
}

const VIBES = [
  ['cafe', /coffee|latte|cappuccino|espresso|shake|sandwich|pastry|brownie|waffle|croissant|cake/i],
  ['chaat', /chaat|pav|puri|vada|samosa|momo|roll|dosa|bhaji|kulcha|paratha/i],
  ['neon', /mocktail|cocktail|hookah|beer|whisky|vodka|shot|bar bites/i],
  ['indigo', /pizza|pasta|burger|nachos|wrap|fries|salad|bruschetta/i],
];
function inferVibe(cats) {
  const items = cats.flatMap((c) => c.items);
  const text = items.map((i) => i.name).join(' ') + ' ' + cats.map((c) => c.name).join(' ');
  const avg = items.reduce((n, i) => n + i.price, 0) / Math.max(1, items.length);
  if (avg > 650) return 'luxe';
  let best = 'haveli', hits = 0;
  for (const [v, re] of VIBES) { const n = (text.match(new RegExp(re.source, 'gi')) || []).length; if (n > hits && n >= 2) { best = v; hits = n; } }
  return best;
}

/** images: [{mediaType, data(base64)}] -> normalised menu, pages merged by section name. */
async function scanMenu(images, onProgress = () => {}) {
  const merged = new Map();
  const warnings = [];
  let name = '', failed = 0, lastErr = '';
  for (const [n, img] of images.entries()) {
    onProgress({ page: n + 1, pages: images.length, queued: pending.size });
    const ext = img.mediaType.includes('png') ? 'png' : img.mediaType.includes('webp') ? 'webp' : 'jpg';
    const tmp = path.join(os.tmpdir(), `menu_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`);
    fs.writeFileSync(tmp, Buffer.from(img.data, 'base64'));
    try {
      let r = null;
      if (await pythonAvailable()) {
        r = await ocrFile(tmp).catch((e) => ({ success: false, error: e.message, crashed: true }));
        if (r.crashed) { pyOk = false; pyWhy = r.error; console.error('[OCR] main engine failed, switching to backup:', r.error); }
      }
      if (!r || !r.success) {
        const second = await lite.readMenu(Buffer.from(img.data, 'base64')).catch((e) => ({ success: false, error: e.message }));
        if (second.success || !r) r = second;
      }
      if (!r.success) { failed++; lastErr = r.error; continue; }
      name = name || r.restaurantName || '';
      warnings.push(...(r.warnings || []));
      for (const c of r.categories) {
        if (!merged.has(c.name)) merged.set(c.name, []);
        merged.get(c.name).push(...c.items);
      }
    } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  }
  const categories = [...merged].map(([n, items]) => {
    const seen = new Set();
    return { name: n, items: items.filter((i) => { const k = i.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }) };
  }).filter((c) => c.items.length);
  if (!categories.length) {
    const e = new Error(lastErr || 'No dishes could be read. Use a clear, straight, well-lit photo of each menu page.');
    e.code = 'UNREADABLE';
    throw e;
  }
  if (failed) warnings.unshift(`${failed} photo(s) could not be read.`);
  return {
    engine: pyOk ? 'local-ocr' : 'lite-ocr', restaurantName: name, tagline: '', cuisine: '', vibe: inferVibe(categories), suggestedPrimary: null, suggestedAccent: null,
    categories, warnings: [...new Set(warnings)].slice(0, 25), totalItems: categories.reduce((n, c) => n + c.items.length, 0),
  };
}

process.on('exit', () => { try { proc && proc.kill(); } catch (_) {} });
/** How many pages are waiting in front of a new scan (shared worker). */
const queueLength = () => pending.size;
module.exports = { scanMenu, warmup, warm, queueLength };
