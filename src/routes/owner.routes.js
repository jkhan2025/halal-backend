const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const Place = require('../../models/Place');  // NOTE: models is outside /src
const Claim = require('../../models/Claim');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'places');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '.jpg').toLowerCase();
    const token = req.params.token || crypto.randomBytes(8).toString('hex');
    cb(null, `place-${token}-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
});

const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 5050}`;

// Util
function isExpired(c) {
  return !c || c.status !== 'pending' || (c.expiresAt && c.expiresAt.getTime() < Date.now());
}

/** -------------------------
 *  POST /api/owner/claim/start
 *  Body: { placeId, email? }
 *  Returns: { ok, token, url }
 *  (In prod you’d email the URL; for now we return it)
 */
router.post('/api/owner/claim/start', async (req, res) => {
  try {
    const { placeId, email } = req.body || {};
    if (!placeId) return res.status(400).json({ ok: false, error: 'MISSING_PLACE_ID' });

    const place = await Place.findById(placeId).lean();
    if (!place) return res.status(404).json({ ok: false, error: 'PLACE_NOT_FOUND' });

    const token = crypto.randomBytes(12).toString('hex'); // 24 chars
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);

    const claim = await Claim.create({ place: place._id, token, email, expiresAt });
    const url = `${PUBLIC_BASE}/owner/claim/${claim.token}`;
    return res.json({ ok: true, token: claim.token, url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/** -------------------------
 *  GET /api/owner/claim/:token
 *  Returns JSON status + basic place info (for apps / Postman)
 */
router.get('/api/owner/claim/:token', async (req, res) => {
  try {
    const claim = await Claim.findOne({ token: req.params.token }).populate('place');
    if (!claim) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    if (isExpired(claim)) return res.status(410).json({ ok: false, error: 'EXPIRED' });

    const p = claim.place || {};
    res.json({
      ok: true,
      claim: { token: claim.token, expiresAt: claim.expiresAt, status: claim.status },
      place: {
        _id: p._id,
        name: p.name,
        city: p.city,
        state: p.state,
        phone: p.phone,
        website: p.website,
        photos: p.photos || [],
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/** -------------------------
 *  POST /api/owner/claim/:token/photo (multipart/form-data)
 *  Fields: photo (file), phone?, website?
 */
router.post('/api/owner/claim/:token/photo', upload.single('photo'), async (req, res) => {
  try {
    const claim = await Claim.findOne({ token: req.params.token }).populate('place');
    if (!claim) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    if (isExpired(claim)) return res.status(410).json({ ok: false, error: 'EXPIRED' });

    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: 'MISSING_FILE' });

    const photoUrl = `${PUBLIC_BASE}/uploads/places/${path.basename(file.path)}`;
    const updates = { photos: [photoUrl, ...(claim.place.photos || [])] };

    // Optional simple contact updates
    const { phone, website } = req.body || {};
    if (typeof phone === 'string' && phone.trim()) updates.phone = phone.trim();
    if (typeof website === 'string' && website.trim()) updates.website = website.trim();

    await Place.updateOne({ _id: claim.place._id }, { $set: updates });
    claim.status = 'used';
    await claim.save();

    res.json({ ok: true, photoUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

/** -------------------------
 *  Tiny HTML page so owners can upload from a phone browser.
 *  GET /owner/claim/:token
 */
router.get('/owner/claim/:token', async (req, res) => {
  try {
    const claim = await Claim.findOne({ token: req.params.token }).populate('place');
    if (!claim) return res.status(404).send('Not found');
    if (isExpired(claim)) return res.status(410).send('This claim link has expired or been used.');

    const p = claim.place || {};
    const action = `/api/owner/claim/${claim.token}/photo`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claim ${p.name || 'Place'}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1110;color:#e9efea;padding:20px;}
  .card{background:#121816;border:1px solid #20332d;border-radius:12px;padding:16px;max-width:560px;margin:0 auto;}
  h1{font-size:18px;margin:0 0 8px}
  label{display:block;font-size:13px;margin:10px 0 4px;color:#b9c4bf}
  input[type="text"],input[type="url"],input[type="tel"],input[type="file"]{
    width:100%;padding:10px;border-radius:8px;border:1px solid #2a3d36;background:#0f1413;color:#e9efea;
  }
  button{margin-top:12px;background:#1f7a4a;border:0;padding:12px 16px;border-radius:10px;color:#fff;font-weight:700}
  .hint{font-size:12px;color:#9db0a7;margin-top:8px}
</style>
</head>
<body>
  <div class="card">
    <h1>Claim: ${p.name || ''}</h1>
    <div class="hint">${p.city || ''} ${p.state || ''}</div>
    <form method="post" action="${action}" enctype="multipart/form-data">
      <label>Storefront photo (JPG/PNG)</label>
      <input type="file" name="photo" accept="image/*" required>

      <label>Phone (optional)</label>
      <input type="tel" name="phone" placeholder="${p.phone || ''}">

      <label>Website (optional)</label>
      <input type="url" name="website" placeholder="${p.website || ''}">

      <button type="submit">Upload</button>
      <div class="hint">Your photo will appear in the Halal Quest app once uploaded.</div>
    </form>
  </div>
</body>
</html>`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

module.exports = router;
