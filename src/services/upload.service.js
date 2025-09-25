const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { UPLOAD_DIR } = require('../config/env');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const code = String(req.body?.code || 'unknown');
    const ts = Date.now();
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    const kind = file.fieldname; // 'front' or 'ingredients'
    cb(null, `rpt_${ts}_${kind}_${code}${ext}`);
  },
});

module.exports = multer({ storage });
