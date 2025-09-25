exports.create = (req, res, next) => {
  try {
    const code = String(req.body?.code || '').trim();
    const front = req.files?.front?.[0]?.filename || null;
    const ingredients = req.files?.ingredients?.[0]?.filename || null;

    if (!code || (!front && !ingredients)) {
      return res.status(400).json({ error: 'code and at least one photo are required' });
    }

    return res.status(201).json({
      ok: true,
      code,
      front: front ? `/uploads/${front}` : null,
      ingredients: ingredients ? `/uploads/${ingredients}` : null,
      receivedAt: Date.now(),
    });
  } catch (e) {
    next(e);
  }
};
