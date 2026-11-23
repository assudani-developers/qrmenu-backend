const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { db, persistDb } = require('../db');

/**
 * POST /api/menu/ocr-scan
 * High-accuracy Paper Menu Card to Digital JSON Converter
 * Powered by Python EasyOCR + RapidFuzz Culinary Dictionary
 */
router.post('/ocr-scan', async (req, res) => {
  try {
    const { imageBase64, restaurantId, autoImport = false } = req.body;

    if (!imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'Please provide imageBase64 of your paper menu photo',
      });
    }

    // Decode base64 to temporary image file
    const matches = imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    const base64Data = matches ? matches[2] : imageBase64;
    const buffer = Buffer.from(base64Data, 'base64');

    const tempDir = path.join(__dirname, '../../data/tmp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempFilePath = path.join(tempDir, `menu_upload_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.png`);
    fs.writeFileSync(tempFilePath, buffer);

    const scriptPath = path.join(__dirname, '../ocr/menu_ocr.py');

    // Run Python OCR engine
    const pythonProc = spawn('python3', [scriptPath, tempFilePath]);

    let stdoutData = '';
    let stderrData = '';

    pythonProc.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
    });

    pythonProc.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    pythonProc.on('close', (code) => {
      // Clean up temp file
      try {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      } catch (e) {}

      if (code !== 0 && !stdoutData.trim()) {
        console.error('[OCR Engine Error]', stderrData);
        return res.status(500).json({
          success: false,
          error: 'OCR Engine failed to process menu image.',
          details: stderrData,
        });
      }

      try {
        // Find valid JSON in stdout
        const jsonStart = stdoutData.indexOf('{');
        const jsonEnd = stdoutData.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd === -1) {
          throw new Error('No JSON output from OCR engine');
        }

        const jsonStr = stdoutData.substring(jsonStart, jsonEnd + 1);
        const result = JSON.parse(jsonStr);

        // If autoImport requested and restaurantId provided, persist items to restaurant menu
        if (autoImport && restaurantId && result.success && result.categories) {
          const restaurant = db.restaurants.find((r) => r.id === restaurantId || r.slug === restaurantId);
          if (restaurant) {
            if (!restaurant.menu) restaurant.menu = [];

            const importedDishes = [];
            for (const cat of result.categories) {
              for (const item of cat.items) {
                const newDish = {
                  id: `dish_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                  name: item.name,
                  price: item.price,
                  halfPrice: item.halfPrice || null,
                  category: cat.name,
                  description: item.description || '',
                  isVeg: item.isVeg,
                  isAvailable: true,
                  createdAt: new Date().toISOString(),
                };
                restaurant.menu.push(newDish);
                importedDishes.push(newDish);
              }
            }

            persistDb();

            // Emit live websocket update to all dining tables & POS consoles
            const io = req.app.get('io');
            if (io) {
              io.emit('menu:bulk_imported', {
                restaurantId: restaurant.id,
                count: importedDishes.length,
                dishes: importedDishes,
              });
            }

            result.importedCount = importedDishes.length;
            result.restaurant = restaurant;
          }
        }

        return res.status(200).json(result);
      } catch (parseErr) {
        console.error('[OCR Parse Error]', parseErr, stdoutData);
        return res.status(500).json({
          success: false,
          error: 'Failed to parse structured JSON from OCR output',
          rawStdout: stdoutData,
        });
      }
    });
  } catch (err) {
    console.error('[OCR API Error]', err);
    return res.status(500).json({ success: false, error: 'Internal server error in OCR API' });
  }
});

module.exports = router;
