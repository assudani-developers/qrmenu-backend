/**
 * Fast, offline photo clarity check (runs before OCR so the owner hears "retake it" in under a second).
 * Measures on a normalised 1000px-wide greyscale copy:
 *  - sharpness: spread of the Laplacian (edges of printed text). Blurry / shaky photos score low.
 *  - brightness & contrast: too dark, washed out or flat photos are flagged.
 *  - size: tiny images cannot hold readable menu text.
 */
const sharp = require('sharp');

// minFocus = edge strength relative to contrast; calibrated on test_data/synthetic (clear ≥ .28, blurred ≤ .10).
const LIMITS = { minSide: 600, minFocus: 0.15, minSharp: 3, minBright: 55, maxBright: 245, minContrast: 12 };

async function checkPhoto(buf) {
  try {
    const img = sharp(buf, { failOn: 'none' }).rotate();
    const meta = await img.metadata();
    const w = meta.width || 0, h = meta.height || 0;
    if (Math.min(w, h) < LIMITS.minSide) {
      return { ok: false, issue: 'small', reason: 'the photo is too small. Use your camera at full quality.', width: w, height: h };
    }
    const { data, info } = await img.clone().greyscale().resize({ width: 1000 }).raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height, n = W * H;
    let sum = 0, sum2 = 0, clipped = 0;
    for (let i = 0; i < n; i++) { const v = data[i]; sum += v; sum2 += v * v; if (v >= 252) clipped++; }
    const mean = sum / n;
    // Laplacian variance over the inner image; text edges dominate it in a sharp photo.
    let ls = 0, ls2 = 0, m = 0;
    for (let y = 1; y < H - 1; y += 1) {
      for (let x = 1; x < W - 1; x += 1) {
        const i = y * W + x;
        const l = data[i - W] + data[i + W] + data[i - 1] + data[i + 1] - 4 * data[i];
        ls += l; ls2 += l * l; m++;
      }
    }
    const lapVar = ls2 / m - (ls / m) ** 2;
    const brightness = Math.round(mean);
    const contrast = Math.round(Math.sqrt(Math.max(0, sum2 / n - mean * mean)));
    const sharpness = Math.round(Math.sqrt(lapVar) * 10) / 10;
    const glare = clipped / n;
    const focus = contrast ? Math.round((sharpness / contrast) * 100) / 100 : 0;
    const base = { width: w, height: h, brightness, contrast, sharpness, focus, glare: Math.round(glare * 100) / 100 };
    if (brightness < LIMITS.minBright) return { ok: false, issue: 'dark', reason: 'it is too dark. Turn on a light or move near a window.', ...base };
    if (brightness > LIMITS.maxBright && contrast < LIMITS.minContrast) return { ok: false, issue: 'bright', reason: 'there is too much glare. Tilt the menu away from the light.', ...base };
    if (contrast < LIMITS.minContrast) return { ok: false, issue: 'flat', reason: 'the text is hard to see. Fill the frame with the menu.', ...base };
    if (sharpness < LIMITS.minSharp || focus < LIMITS.minFocus) return { ok: false, issue: 'blur', reason: 'it looks blurry. Hold the phone steady and tap to focus.', ...base };
    return { ok: true, issue: null, reason: 'Clear photo', ...base };
  } catch (_) {
    return { ok: false, issue: 'unreadable', reason: 'we could not open this image. Try another photo.' };
  }
}

module.exports = { checkPhoto, LIMITS };
