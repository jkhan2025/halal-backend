// backend/scripts/geocode-place-file.js
// Usage: node scripts/geocode-place-file.js src/data/ct_groceries.json
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function geocode(addr) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(addr)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'HalalQuest/1.0 (contact@example.com)' },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data) || !data[0]) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

(async () => {
  const file = process.argv[2];
  if (!file) {
    console.error('Pass a file path, e.g. node scripts/geocode-place-file.js src/data/ct_groceries.json');
    process.exit(1);
  }
  const abs = path.resolve(file);
  const arr = JSON.parse(fs.readFileSync(abs, 'utf8'));
  let updated = 0;

  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    if (p.coords && typeof p.coords.lat === 'number' && typeof p.coords.lng === 'number') continue;
    const addr = [p.address, p.city, p.state, p.postcode].filter(Boolean).join(', ');
    if (!addr) continue;

    try {
      const c = await geocode(addr);
      if (c) {
        p.coords = c;
        updated++;
        console.log('✓', p.name, '->', c.lat.toFixed(6), c.lng.toFixed(6));
      } else {
        console.log('× no match:', p.name);
      }
    } catch (e) {
      console.log('× error:', p.name, e.message);
    }
    await sleep(1200); // be nice to Nominatim
  }

  const out = abs.replace(/\.json$/i, '.geocoded.json');
  fs.writeFileSync(out, JSON.stringify(arr, null, 2));
  console.log(`Done. Updated ${updated}. Wrote ${out}`);
})();
