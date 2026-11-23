const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer in-memory storage so sharp can process the buffer directly
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // Handles up to 25MB raw phone photos
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  },
});

/**
 * POST /api/upload
 * Compresses 10MB+ images into optimized ~80-100KB .webp format
 */
router.post('/image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const originalSizeKb = Math.round(req.file.size / 1024);
    const fileName = `dish_${Date.now()}_${Math.random().toString(36).substring(7)}.webp`;
    const outputPath = path.join(uploadDir, fileName);

    // Sharp pipeline: Resize to max 900px width/height, auto-rotate EXIF, convert to WebP quality 80
    await sharp(req.file.buffer)
      .rotate() // Auto-rotates based on phone orientation metadata
      .resize(900, 900, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 80, effort: 4 })
      .toFile(outputPath);

    const compressedStats = fs.statSync(outputPath);
    const compressedSizeKb = Math.round(compressedStats.size / 1024);

    console.log(
      `[Image Compression] Original: ${originalSizeKb} KB -> Compressed: ${compressedSizeKb} KB (Saved ${Math.round(
        ((originalSizeKb - compressedSizeKb) / originalSizeKb) * 100
      )}%)`
    );

    const publicUrl = `/uploads/${fileName}`;

    return res.status(200).json({
      success: true,
      url: publicUrl,
      fileName,
      originalSizeKb: `${originalSizeKb} KB`,
      compressedSizeKb: `${compressedSizeKb} KB`,
      format: 'webp',
    });
  } catch (error) {
    console.error('[Upload Error]:', error);
    return res.status(500).json({ error: 'Image compression failed', details: error.message });
  }
});

module.exports = router;

