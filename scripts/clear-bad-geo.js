// scripts/clear-bad-geo.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Place = require('../models/Place');

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const badGeo = await Place.updateMany(
      {
        $or: [
          { 'geo.type': 'Point', 'geo.coordinates': { $exists: false } },
          { 'geo.coordinates': { $type: 'array', $size: 0 } },
        ],
      },
      { $unset: { geo: 1 } }
    );
    console.log('Cleared bad geo:', badGeo.modifiedCount);

    const badPromo = await Place.updateMany(
      {
        $or: [
          { 'promo.geoCenter.type': 'Point', 'promo.geoCenter.coordinates': { $exists: false } },
          { 'promo.geoCenter.coordinates': { $type: 'array', $size: 0 } },
        ],
      },
      { $unset: { 'promo.geoCenter': 1 } }
    );
    console.log('Cleared bad promo geo:', badPromo.modifiedCount);

    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
