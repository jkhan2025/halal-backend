// backend/scripts/fix-geo.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

// try both possible model locations
function loadPlaceModel() {
  const root = path.join(__dirname, '..');
  const candidates = [
    path.join(root, 'src', 'models', 'Place.js'),
    path.join(root, 'models', 'Place.js'),
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) {
    throw new Error(`Place model not found. Tried:\n${candidates.join('\n')}`);
  }
  console.log('Using Place model at:', found.replace(root + path.sep, ''));
  return require(found);
}

(async () => {
  try {
    const Place = loadPlaceModel();
    if (!process.env.MONGO_URI) {
      throw new Error('MISSING MONGO_URI in backend/.env');
    }
    await mongoose.connect(process.env.MONGO_URI);

    // clear bad geo objects: { type: "Point" } without coordinates
    const r1 = await Place.updateMany(
      {
        'geo.type': { $exists: true },
        $or: [
          { 'geo.coordinates': { $exists: false } },
          { 'geo.coordinates': { $size: 0 } },
        ],
      },
      { $unset: { geo: '' } }
    );

    // clear bad promo geofence, if present
    const r2 = await Place.updateMany(
      {
        'promo.geoCenter.type': { $exists: true },
        $or: [
          { 'promo.geoCenter.coordinates': { $exists: false } },
          { 'promo.geoCenter.coordinates': { $size: 0 } },
        ],
      },
      { $unset: { 'promo.geoCenter': '' } }
    );

    console.log('Fixed docs:', { geoCleared: r1.modifiedCount, promoGeoCleared: r2.modifiedCount });
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
