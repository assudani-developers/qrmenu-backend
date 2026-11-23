/**
 * Backup menu reader in pure Node (Tesseract compiled to WebAssembly) — used when the Python engine is not
 * installed or not ready on the server. No Python, no model download, no cloud: the English + Hindi language
 * files ship inside node_modules. Turns the text into sections and dishes with prices, Half/Full, veg marks.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DATA = path.join(__dirname, '../../data/tessdata');
function ensureData() {
  fs.mkdirSync(DATA, { recursive: true });
  for (const [pkg, dir, file] of [['eng', '4.0.0_best_int', 'eng.traineddata.gz'], ['hin', '4.0.0_best_int', 'hin.traineddata.gz']]) {
    const dst = path.join(DATA, file);
    if (!fs.existsSync(dst)) fs.copyFileSync(path.join(path.dirname(require.resolve(`@tesseract.js-data/${pkg}/package.json`)), dir, file), dst);
  }
}

const LANGS = (process.env.OCR_LITE_LANGS || 'eng').split('+'); // add Hindi with OCR_LITE_LANGS=eng+hin (slower, noisier on photos)
let worker = null, starting = null, idle = null;
async function getWorker() {
  if (worker) return worker;
  if (starting) return starting;
  starting = (async () => {
    ensureData();
    const { createWorker } = require('tesseract.js');
    const w = await createWorker(LANGS, 1, { langPath: DATA, cachePath: DATA, gzip: true, logger: () => {} });
    await w.setParameters({ preserve_interword_spaces: '1' });
    worker = w; starting = null;
    return w;
  })();
  try { return await starting; } catch (e) { starting = null; throw e; }
}
function release() {
  clearTimeout(idle);
  idle = setTimeout(async () => { const w = worker; worker = null; if (w) await w.terminate().catch(() => {}); }, 10 * 60 * 1000);
  if (idle.unref) idle.unref();
}

const PRICE = /(?:₹|rs\.?|inr)?\s*(\d{2,5})(?:\s*[\/|:;]\s*(\d{2,5}))?(?:\s*[\/|:;]\s*(\d{2,5}))?\s*(?:\/-|-)?\s*$/i;
const SECTION_WORDS = /^(starters?|appetizers?|soups?|salads?|main ?course|mains|breads?|rotis?|rice|biryani|desserts?|sweets|beverages?|drinks|shakes|mocktails|snacks|chinese|tandoor|thali|combos?|breakfast|sandwich(es)?|pizzas?|burgers?|pasta|south indian|north indian|specials?|sides?|chaat|rolls|momos|noodles|raita|veg|non[ -]?veg|boiler|gavran|mutton|chicken|paneer|seafood|egg|fish)\b/i;
const NONVEG = /chicken|mutton|fish|prawn|egg|keema|lamb|kebab|tikka masala|seekh|meat|crab|gavran|boiler|non[ -]?veg/i;
const PRICE_ONLY = /^[₹rs.\s]*\d{2,5}(\s*[\/|:;]\s*\d{2,5})*\s*(\/-)?$/i;
const tidy = (s) => s.replace(/^\s*[\[(][^\])\s]{0,3}[\])]?\s+/, '').replace(/^[^A-Za-z0-9\u0900-\u097F]+/, '').replace(/[|_~`•·…]+/g, ' ').replace(/\.{2,}|-{2,}/g, ' ').replace(/\s{2,}/g, ' ').trim();
const title = (s) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s);

/** Spelling repair against the same culinary word list the main engine uses ("Maln Course" → "Main Course"). */
const LEX = require('../ocr/lexicon.json');
function dist(a, b) {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return m[a.length][b.length];
}
function repair(name, list, min = 0.84) {
  const n = name.toLowerCase();
  let best = null, score = 0;
  for (const x of list) {
    const l = x.toLowerCase();
    if (Math.abs(l.length - n.length) > 3) continue;
    const sc = 1 - dist(n, l) / Math.max(n.length, l.length);
    if (sc > score) { score = sc; best = x; }
  }
  return score >= min && score < 1 ? best.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : name;
}

/** Lines of text → { restaurantName, categories:[{name, items}] } */
function parseLines(lines) {
  const cats = []; let cur = null, last = null, name = '';
  const cat = (n) => { cur = cats.find((c) => c.name.toLowerCase() === n.toLowerCase()); if (!cur) { cur = { name: n, items: [] }; cats.push(cur); } };
  for (const raw of lines) {
    const t = tidy(raw.text);
    if (t.length < 2) continue;
    const m = t.match(PRICE);
    const letters = t.replace(/[^A-Za-zऀ-ॿ]/g, '');
    if (m && letters.length >= 2) {
      const dish = tidy(t.slice(0, m.index)).replace(/[:\-–]+$/, '').trim();
      if (dish.length < 2) continue;
      const prices = [m[1], m[2], m[3]].filter(Boolean).map(Number).filter((p) => p >= 5 && p <= 50000);
      if (!prices.length) continue;
      if (!cur) cat('Menu');
      const item = { name: repair(title(dish), LEX.dishes), price: Math.min(...prices), description: '', isVeg: !NONVEG.test(dish + ' ' + cur.name), spiceLevel: /spicy|chilli|schezwan/i.test(dish) ? 'spicy' : 'none', tags: [], variants: [], confidence: +(raw.confidence / 100).toFixed(2) };
      if (prices.length === 2) item.variants = [{ name: 'Half', price: prices[0] }, { name: 'Full', price: prices[1] }];
      if (prices.length === 3) item.variants = ['Small', 'Medium', 'Large'].map((n, i) => ({ name: n, price: prices[i] }));
      cur.items.push(item); last = item;
      continue;
    }
    if (!letters.length) { // a price-only line belongs to the dish above
      const pm = t.match(/(\d{2,5})/); if (last && pm && !last.price) last.price = Number(pm[1]);
      continue;
    }
    const words = t.split(' ').length;
    const upper = letters === letters.toUpperCase() && /[A-Z]/.test(letters);
    if ((upper && words <= 5) || (SECTION_WORDS.test(t) && words <= 4) || /:\s*$/.test(t)) {
      if (!cats.length && !name && words <= 5 && !SECTION_WORDS.test(t)) { name = title(t); continue; }
      cat(repair(title(t.replace(/[:\s]+$/, '')), LEX.sections, 0.75));
      last = null;
      continue;
    }
    if (last && (t[0] === t[0].toLowerCase() || words > 3 || /,/.test(t))) { last.description = (last.description + ' ' + t).trim().slice(0, 160); continue; }
    if (!name && !cats.length) name = title(t);
  }
  for (const c of cats) {
    for (const item of c.items) {
      const s = String(item.description || '').trim();
      const alpha = (s.match(/[A-Za-z\u0900-\u097F]/g) || []).length;
      if (s.length < 5 || alpha < 4 || (alpha / s.length) < 0.45 || /(\.{3,}|-{3,}|_{3,}|\*{3,}|={3,})/.test(s) || !/[A-Za-z\u0900-\u097F]{3,}/.test(s)) {
        item.description = '';
      }
    }
  }
  return { restaurantName: name, categories: cats.filter((c) => c.items.length) };
}

/** Even out light and shadows (photo of a menu on a table): divide by a heavy blur, then stretch contrast. */
async function flatten(buf, width) {
  const base = sharp(buf).rotate().resize({ width, height: Math.round(width * 1.45), fit: 'inside', withoutEnlargement: false }).greyscale();
  const { data: g, info } = await base.clone().raw().toBuffer({ resolveWithObject: true });
  const { data: bl } = await sharp(g, { raw: { width: info.width, height: info.height, channels: 1 } }).blur(Math.max(8, info.width / 30)).raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(g.length);
  for (let i = 0; i < g.length; i++) out[i] = Math.min(255, Math.round((g[i] / Math.max(1, bl[i])) * 235));
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } }).normalise({ lower: 2, upper: 98 }).png().toBuffer();
}

/** Words → text lines split at wide gaps → columns (by left edge) → reading order: column by column, top to bottom. */
function toLines(data) {
  const segs = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const ws = (l.words || []).filter((w) => w.text.trim());
    if (!ws.length) continue;
    const h = Math.max(8, ws.reduce((n, w) => n + (w.bbox.y1 - w.bbox.y0), 0) / ws.length);
    const parts = [];
    let cur = [ws[0]];
    for (let i = 1; i < ws.length; i++) {
      if (ws[i].bbox.x0 - ws[i - 1].bbox.x1 > h * 2.6) { parts.push(cur); cur = []; }
      cur.push(ws[i]);
    }
    parts.push(cur);
    // a price after a wide gap stays with its dish (tilted photos put it higher or lower than the name)
    for (const part of parts) {
      const t = part.map((w) => w.text).join(' ');
      if (segs.length && segs[segs.length - 1].line === l && PRICE_ONLY.test(t)) segs[segs.length - 1].push(...part);
      else { part.line = l; segs.push(part); }
    }
  }
  const lines = segs.map((ws) => ({
    text: ws.map((w) => w.text).join(' '), confidence: ws.reduce((n, w) => n + w.confidence, 0) / ws.length,
    x0: Math.min(...ws.map((w) => w.bbox.x0)), y0: Math.min(...ws.map((w) => w.bbox.y0)), x1: Math.max(...ws.map((w) => w.bbox.x1)),
  }));
  if (!lines.length) return [];
  // a price-only segment sitting right of a name joins it (dotted-leader menus)
  for (const l of lines) if (PRICE_ONLY.test(l.text)) {
    const host = lines.find((o) => o !== l && !o.joined && Math.abs(o.y0 - l.y0) < 14 && o.x1 < l.x0 && !/\d{2,5}\s*$/.test(o.text));
    if (host) { host.text += ' ' + l.text; l.joined = true; }
  }
  const live = lines.filter((l) => !l.joined);
  // two columns only when lines really sit side by side; centred headings alone never make a column
  const mids = [];
  for (const l of live) for (const r of live) if (r !== l && r.x0 > l.x1 && Math.abs(r.y0 - l.y0) < 18) mids.push((l.x1 + r.x0) / 2);
  const split = mids.length >= 3 ? mids.sort((a, b) => a - b)[Math.floor(mids.length / 2)] : Infinity;
  const colOf = (l) => (l.x0 >= split ? 1 : 0);
  return live.sort((a, b) => colOf(a) - colOf(b) || a.y0 - b.y0);
}

/** Read one photo: try the photo as-is and with light evened out, keep whichever finds more dishes. */
async function readMenu(buf) {
  const w = await getWorker();
  try {
    let best = null;
    for (const prep of [
      () => sharp(buf).rotate().resize({ width: 1700, height: 2400, fit: 'inside', withoutEnlargement: false }).greyscale().png().toBuffer(),
      // phone photos: remove paper grain, then pure black on white
      () => sharp(buf).rotate().resize({ width: 1900 }).greyscale().median(7).normalise().threshold(150).png().toBuffer(),
      async () => sharp(await flatten(buf, 1900)).median(5).threshold(170).png().toBuffer(),
    ]) {
      const { data } = await w.recognize(await prep(), {}, { blocks: true });
      const out = parseLines(toLines(data));
      for (const c of out.categories) c.items = c.items.filter((i) => i.confidence >= 0.5 && /[A-Za-z\u0900-\u097F]{3}/.test(i.name));
      out.categories = out.categories.filter((c) => c.items.length);
      const items = out.categories.flatMap((c) => c.items);
      out.total = items.length;
      out.score = items.reduce((n, i) => n + i.confidence, 0);
      if (!best || out.score > best.score) best = out;
      if (best.total >= 6 && best.score / best.total >= 0.8) break; // clean read: skip the slower passes
    }
    const { total, score, ...menu } = best;
    if (!total) return { success: false, error: 'No dishes could be read. Use a clear, straight, well-lit photo of each menu page.' };
    const warnings = menu.categories.flatMap((c) => c.items.filter((i) => i.confidence < 0.6).map((i) => `Please verify “${i.name}” (hard to read).`)).slice(0, 25);
    return { success: true, engine: 'lite-ocr', ...menu, totalItems: total, warnings };
  } finally { release(); }
}

/** Plain text of an image (used to check payment screenshots). Two reads: normal page layout, then "sparse text",
 *  which catches big lone lines like the amount that the layout pass sometimes skips. */
async function readText(buf) {
  const w = await getWorker();
  try {
    const img = await sharp(buf).rotate().resize({ width: 1100, withoutEnlargement: true }).greyscale().png().toBuffer();
    const out = [];
    for (const psm of ['3', '11']) {
      await w.setParameters({ tessedit_pageseg_mode: psm });
      out.push(String((await w.recognize(img)).data.text || ''));
    }
    return out.join('\n');
  } finally {
    await w.setParameters({ tessedit_pageseg_mode: '3' }).catch(() => {});
    release();
  }
}

const warm = () => { getWorker().then(release).catch(() => {}); };
/** Stop the worker now (tests, shutdown) so it does not keep the process alive. */
async function terminate() { clearTimeout(idle); const w = worker; worker = null; if (w) await w.terminate().catch(() => {}); }
module.exports = { readMenu, readText, parseLines, toLines, warm, terminate };
