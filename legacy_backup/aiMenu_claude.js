/**
 * Menu photo -> structured digital menu.
 * Primary engine: Claude vision (ANTHROPIC_API_KEY). Fallback: local EasyOCR pipeline.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const MENU_TOOL = {
  name: 'submit_menu',
  description: 'Submit the fully structured digital menu extracted from the photo(s) of a restaurant menu.',
  input_schema: {
    type: 'object',
    properties: {
      restaurantName: { type: 'string', description: 'Restaurant name if printed on the menu, else empty' },
      tagline: { type: 'string', description: 'Short tagline if printed, else a tasteful 6-8 word one inferred from the cuisine' },
      cuisine: { type: 'string', description: 'e.g. North Indian, Cafe, Chinese, Street Food' },
      vibe: { type: 'string', enum: ['classic', 'minimal', 'modern', 'cafe', 'street', 'luxe', 'neon'], description: 'Best matching visual template for this restaurant' },
      suggestedPrimary: { type: 'string', description: 'Hex brand colour that fits the cuisine/vibe e.g. #D97706' },
      suggestedAccent: { type: 'string', description: 'Hex dark accent colour' },
      categories: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  price: { type: 'number', description: 'Base price in rupees (lowest/half price when multiple sizes). 0 if unreadable' },
                  description: { type: 'string', description: 'Printed description, or a short appetising one (max 14 words) if none printed' },
                  isVeg: { type: 'boolean' },
                  spiceLevel: { type: 'string', enum: ['none', 'mild', 'medium', 'spicy'] },
                  tags: { type: 'array', items: { type: 'string', enum: ['bestseller', 'chef-special', 'new', 'jain', 'gluten-free', 'sweet', 'beverage'] } },
                  variants: {
                    type: 'array',
                    description: 'Size/portion options when the menu lists several prices (Half/Full, S/M/L)',
                    items: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number' } }, required: ['name', 'price'] },
                  },
                },
                required: ['name', 'price', 'isVeg'],
              },
            },
          },
          required: ['name', 'items'],
        },
      },
      warnings: { type: 'array', items: { type: 'string' }, description: 'Anything unreadable or uncertain the owner should double-check' },
    },
    required: ['categories'],
  },
};

const SYSTEM = `You digitise restaurant menus from photos for Indian restaurants (menus may be Hinglish/Hindi/English).
Rules: keep dish names exactly as printed (fix obvious OCR-like typos only); never invent dishes; group dishes under the printed
section headings; prices are in rupees; when a dish shows two or more prices (Half/Full, Small/Large, Regular/Large) put the lowest as
price and every option in variants; infer isVeg from veg/non-veg marks (green/red dots) or the ingredients; mark clear signature
dishes with tags; list anything illegible in warnings. Always answer by calling submit_menu.`;

async function viaClaude(images) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const content = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data },
  }));
  content.push({ type: 'text', text: 'Digitise this menu completely. Include every dish on every page.' });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools: [MENU_TOOL],
      tool_choice: { type: 'tool', name: 'submit_menu' },
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Claude API ${res.status}: ${txt.slice(0, 300)}`);
  }
  const json = await res.json();
  const block = (json.content || []).find((b) => b.type === 'tool_use');
  if (!block) throw new Error('Claude returned no structured menu');
  return { engine: 'claude', ...block.input };
}

function extFor(mediaType) {
  return mediaType.includes('png') ? 'png' : mediaType.includes('webp') ? 'webp' : 'jpg';
}

async function viaEasyOcr(images) {
  const scriptPath = path.join(__dirname, '../ocr/menu_ocr.py');
  if (!fs.existsSync(scriptPath)) return null;
  const merged = new Map();
  for (const img of images) {
    const tmp = path.join(os.tmpdir(), `menu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${extFor(img.mediaType)}`);
    fs.writeFileSync(tmp, Buffer.from(img.data, 'base64'));
    try {
      const out = await new Promise((resolve, reject) => {
        const p = spawn('python3', [scriptPath, tmp]);
        let so = '';
        p.stdout.on('data', (c) => (so += c));
        p.on('error', reject);
        p.on('close', () => resolve(so));
        setTimeout(() => { p.kill(); reject(new Error('OCR timeout')); }, 120000);
      });
      const a = out.indexOf('{'), b = out.lastIndexOf('}');
      if (a < 0) continue;
      const parsed = JSON.parse(out.slice(a, b + 1));
      for (const cat of parsed.categories || []) {
        if (!merged.has(cat.name)) merged.set(cat.name, []);
        merged.get(cat.name).push(...(cat.items || []).map((i) => ({
          name: i.name, price: Number(i.price) || 0, description: i.description || '', isVeg: i.isVeg !== false,
          variants: i.halfPrice ? [{ name: 'Half', price: i.halfPrice }, { name: 'Full', price: i.price }] : [],
        })));
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }
  if (!merged.size) return null;
  return {
    engine: 'easyocr',
    categories: [...merged].map(([name, items]) => ({ name, items })),
    warnings: ['Scanned with the offline engine — please review names and prices.'],
  };
}

/** Normalise any engine's output so the apps can rely on it. */
function normalise(m) {
  const cats = (m.categories || [])
    .map((c) => ({
      name: String(c.name || 'Menu').trim(),
      items: (c.items || [])
        .filter((i) => i && i.name && String(i.name).trim())
        .map((i) => ({
          name: String(i.name).trim(),
          price: Math.max(0, Number(i.price) || 0),
          description: String(i.description || '').trim(),
          isVeg: i.isVeg !== false,
          spiceLevel: ['none', 'mild', 'medium', 'spicy'].includes(i.spiceLevel) ? i.spiceLevel : 'none',
          tags: Array.isArray(i.tags) ? i.tags : [],
          variants: (i.variants || []).filter((v) => v && v.name).map((v) => ({ name: String(v.name), price: Number(v.price) || 0 })),
        })),
    }))
    .filter((c) => c.items.length);
  return {
    engine: m.engine,
    restaurantName: m.restaurantName || '',
    tagline: m.tagline || '',
    cuisine: m.cuisine || '',
    vibe: m.vibe || 'classic',
    suggestedPrimary: /^#[0-9a-fA-F]{6}$/.test(m.suggestedPrimary || '') ? m.suggestedPrimary : null,
    suggestedAccent: /^#[0-9a-fA-F]{6}$/.test(m.suggestedAccent || '') ? m.suggestedAccent : null,
    categories: cats,
    warnings: m.warnings || [],
    totalItems: cats.reduce((n, c) => n + c.items.length, 0),
  };
}

async function scanMenu(images) {
  let claudeErr = null;
  try {
    const r = await viaClaude(images);
    if (r) return normalise(r);
  } catch (e) {
    claudeErr = e;
    console.error('[AI Menu] Claude failed, trying offline OCR:', e.message);
  }
  try {
    const r = await viaEasyOcr(images);
    if (r) {
      const n = normalise(r);
      if (claudeErr) n.warnings.unshift('AI engine unavailable, used offline scanner.');
      return n;
    }
  } catch (e) {
    console.error('[AI Menu] EasyOCR failed:', e.message);
  }
  const err = new Error(process.env.ANTHROPIC_API_KEY
    ? 'Could not read the menu photo. Try a clearer, well-lit, straight-on photo.'
    : 'No AI engine configured. Set ANTHROPIC_API_KEY in backend/.env to enable photo-to-menu.');
  err.code = process.env.ANTHROPIC_API_KEY ? 'UNREADABLE' : 'NO_ENGINE';
  throw err;
}

module.exports = { scanMenu };
