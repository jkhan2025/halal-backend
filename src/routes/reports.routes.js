const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const { body, validationResult } = require('express-validator');
const Report = require('../models/Report');

// Multer v2
const upload = multer({
  dest: path.resolve('uploads'),
  limits: { fileSize: 3 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpe?g|png|webp)$/i.test(file.mimetype);
    cb(ok ? null : new Error('Only image files allowed'), ok);
  },
});

// POST /api/reports  (fields: code, optional note; files: front, ingredients)
router.post(
  '/',
  upload.fields([{ name: 'front', maxCount: 1 }, { name: 'ingredients', maxCount: 1 }]),
  body('code').isString().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const front = (req.files?.front?.[0] && `/uploads/${req.files.front[0].filename}`) || null;
    const ingredients = (req.files?.ingredients?.[0] && `/uploads/${req.files.ingredients[0].filename}`) || null;

    const doc = await Report.create({
      code: req.body.code.trim(),
      note: (req.body.note || '').trim() || null,
      frontUri: front,
      ingrUri: ingredients,
      status: 'Pending',
      createdAt: new Date(),
    });

    res.status(201).json(doc);
  }
);

// GET /api/reports?code= (admin)
router.get('/', (req, res, next) => {
  const key = req.header('x-admin-key') || req.query.key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}, async (req, res) => {
  const filter = {};
  if (req.query.code) filter.code = new RegExp(req.query.code, 'i');
  const items = await Report.find(filter).sort({ createdAt: -1 }).lean();
  res.json({ items, count: items.length });
});

// PATCH /api/reports/:id  { status } (admin)
router.patch('/:id', (req, res, next) => {
  const key = req.header('x-admin-key') || req.query.key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}, async (req, res) => {
  const { status } = req.body;
  const doc = await Report.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!doc) return res.status(404).json({ error: 'not_found' });
  res.json(doc);
});

module.exports = router;
