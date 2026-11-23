/**
 * Photo -> menu, fully offline. Talks to a persistent Python worker (src/ocr/worker.py) that keeps the
 * OCR models in memory, so only the first scan after boot pays the model-load cost.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PY = process.env.PYTHON_BIN || 'python3';
const WORKER = path.join(__dirname, '../ocr/worker.py');
const TIMEOUT_MS = 150000;
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

let proc = null, ready = null, buf = '', seq = 0;
const pending = new Map();

function start() {
  if (ready) return ready;
  proc = spawn(PY, [WORKER], { stdio: ['pipe', 'pipe', 'pipe'] });
  ready = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('OCR engine failed to start')), 120000);
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
  proc.stderr.on('data', () => {});
  ready.catch(() => { try { proc && proc.kill(); } catch (_) {} reset(); });
  return ready;
}

/** Load the models in the background. Called when an owner opens the scan screen, so they are ready by the
 *  time the photos are taken. At boot only when OCR_PRELOAD=1 (keeps RAM free on small servers). */
function warm() { touch(); start().catch((e) => console.error('[OCR] warmup failed:', e.message)); }
function warmup() { if (process.env.OCR_PRELOAD !== '1') return; touch(); start().then(() => console.log('[OCR] engine ready')).catch((e) => console.error('[OCR] warmup failed:', e.message)); }

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
      const r = await ocrFile(tmp);
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
    engine: 'local-ocr', restaurantName: name, tagline: '', cuisine: '', vibe: inferVibe(categories), suggestedPrimary: null, suggestedAccent: null,
    categories, warnings: [...new Set(warnings)].slice(0, 25), totalItems: categories.reduce((n, c) => n + c.items.length, 0),
  };
}

process.on('exit', () => { try { proc && proc.kill(); } catch (_) {} });
/** How many pages are waiting in front of a new scan (shared worker). */
const queueLength = () => pending.size;
module.exports = { scanMenu, warmup, warm, queueLength };
