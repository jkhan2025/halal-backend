const assert = require('node:assert/strict');
const { test, after, mock } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');

// This suite runs real Mongoose query middleware, but never a server or database.
// Fail immediately if a future change attempts a connection or reads an env file.
const forbiddenAttempts = [];
const forbid = (operation) => () => {
  forbiddenAttempts.push(operation);
  throw new Error(`Isolated test forbids ${operation}`);
};
mock.method(net.Socket.prototype, 'connect', forbid('network connection'));
mock.method(tls, 'connect', forbid('TLS connection'));
const checkFile = (file) => {
  if (/^\.env(?:\.|$)/i.test(path.basename(String(file)))) {
    forbid('environment-file read')();
  }
};
for (const name of ['readFileSync', 'readFile']) {
  const original = fs[name];
  mock.method(fs, name, function (file, ...args) {
    checkFile(file);
    return original.call(this, file, ...args);
  });
}
const readFile = fs.promises.readFile;
mock.method(fs.promises, 'readFile', function (file, ...args) {
  checkFile(file);
  return readFile.call(this, file, ...args);
});

const mongoose = require('mongoose');
mock.method(mongoose, 'connect', forbid('mongoose.connect'));
mock.method(mongoose, 'createConnection', forbid('mongoose.createConnection'));
mock.method(mongoose.Connection.prototype, 'openUri', forbid('database connection'));
const Place = require('../models/Place');

after(() => {
  try {
    assert.deepEqual(forbiddenAttempts, []);
    assert.equal(mongoose.connection.readyState, 0);
    for (const filename of ['../server.js', '../index.js', '../src/app.js']) {
      assert.equal(require.cache[require.resolve(filename)], undefined, 'application server must not load');
    }
    assert.equal(require.cache[require.resolve('dotenv')], undefined, 'dotenv must not load');
  } finally {
    mock.restoreAll();
  }
});

const methods = ['updateOne', 'updateMany', 'findOneAndUpdate'];
const id = new mongoose.Types.ObjectId('000000000000000000000001');
const coords = { lat: 41.1, lng: -73.4 };
const geo = { type: 'Point', coordinates: [-73.4, 41.1] };

function captureCollection(t, method) {
  const writes = [];
  t.mock.method(Place.collection, method, async (filter, update, options) => {
    writes.push({ filter, update, options });
    return method === 'findOneAndUpdate'
      ? { _id: id }
      : { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  });
  return writes;
}

async function execute(t, method, update, options = {}) {
  const writes = captureCollection(t, method);
  await Place[method]({ _id: id }, update, options).exec();
  assert.equal(writes.length, 1, 'real query middleware must reach the stubbed collection once');
  return writes[0].update;
}

function assertNoGeoWrites(update) {
  for (const fields of Object.values(update)) {
    for (const field of Object.keys(fields)) {
      assert.ok(field !== 'geo' && !field.startsWith('geo.'), `unexpected geographic write: ${field}`);
    }
  }
}

for (const method of methods) {
  test(`${method}: impressions preserve geography`, async (t) => {
    const update = await execute(t, method, { $inc: { 'metrics.impressions': 1 } });
    assert.equal(update.$inc['metrics.impressions'], 1);
    assertNoGeoWrites(update);
  });

  test(`${method}: photo/contact updates preserve geography`, async (t) => {
    const fields = { photos: ['/uploads/example.jpg'], phone: '555-0100', website: 'https://example.invalid' };
    const update = await execute(t, method, { $set: fields });
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(update.$set[key], value);
    assertNoGeoWrites(update);
  });

  test(`${method}: plain contact updates preserve geography`, async (t) => {
    const update = await execute(t, method, { phone: '555-0100' });
    assert.equal(update.$set.phone, '555-0100');
    assertNoGeoWrites(update);
  });

  for (const operation of ['$set', '$unset']) {
    test(`${method}: ${operation} promotional geofence preserves main geography`, async (t) => {
      const value = operation === '$set' ? geo : 1;
      const update = await execute(t, method, { [operation]: { 'promo.geoCenter': value } });
      assert.deepEqual(update[operation]['promo.geoCenter'], value);
      assertNoGeoWrites(update);
    });
  }

  const validUpdates = [
    ['full coordinates', { $set: { coords } }],
    ['plain coordinates', { coords }],
    ['complete dotted pair', { $set: { 'coords.lat': coords.lat, 'coords.lng': coords.lng } }],
    ['plain dotted pair', { 'coords.lat': coords.lat, 'coords.lng': coords.lng }],
    ['existing seed shape', { $set: { coords, geo } }],
    ['plain coordinates and geography', { coords, geo }],
  ];
  for (const [name, input] of validUpdates) {
    test(`${method}: ${name} synchronizes GeoJSON`, async (t) => {
      const update = await execute(t, method, input);
      assert.deepEqual(update.$set.geo, geo);
      assert.equal(update.$unset?.geo, undefined);
    });
  }

  for (const point of [{ lat: 0, lng: 0 }, { lat: -90, lng: 180 }, { lat: 90, lng: -180 }]) {
    test(`${method}: valid boundary point ${point.lat},${point.lng}`, async (t) => {
      const update = await execute(t, method, { $set: { coords: point } });
      assert.deepEqual(update.$set.geo, { type: 'Point', coordinates: [point.lng, point.lat] });
    });
  }

  test(`${method}: insertion-only coordinates do not rewrite existing geography`, async (t) => {
    const update = await execute(t, method, { $setOnInsert: { coords }, $set: { phone: '555-0100' } }, { upsert: true });
    assert.deepEqual(update.$setOnInsert.geo, geo);
    assert.equal(update.$set.geo, undefined);
    assert.equal(update.$unset?.geo, undefined);
  });

  test(`${method}: insertion-only dotted coordinates synchronize only on insert`, async (t) => {
    const update = await execute(t, method, {
      $setOnInsert: { 'coords.lat': coords.lat, 'coords.lng': coords.lng },
    }, { upsert: true });
    assert.deepEqual(update.$setOnInsert.geo, geo);
    assert.equal(update.$set?.geo, undefined);
    assert.equal(update.$unset?.geo, undefined);
  });

  test(`${method}: explicit geography maintenance is preserved`, async (t) => {
    const update = await execute(t, method, { $set: { geo } });
    assert.deepEqual(update.$set.geo, geo);
    assert.equal(update.$unset?.geo, undefined);
  });

  test(`${method}: seed shape without coordinates preserves explicit geo removal`, async (t) => {
    const update = await execute(t, method, { $set: { name: 'Synthetic place' }, $unset: { geo: 1 } });
    assert.equal(update.$set.name, 'Synthetic place');
    assert.ok(Object.hasOwn(update.$unset, 'geo'));
    assert.equal(update.$set.geo, undefined);
  });

  for (const value of [1, '']) {
    test(`${method}: intentional geo removal (${JSON.stringify(value)}) remains explicit`, async (t) => {
      const update = await execute(t, method, { $unset: { geo: value } });
      assert.ok(Object.hasOwn(update.$unset, 'geo'));
      assert.equal(update.$set?.geo, undefined);
      assert.equal(update.$unset.coords, undefined);
    });
  }

  test(`${method}: explicit coordinate removal also removes derived geography`, async (t) => {
    const update = await execute(t, method, { $unset: { coords: 1 } });
    assert.ok(Object.hasOwn(update.$unset, 'coords'));
    assert.ok(Object.hasOwn(update.$unset, 'geo'));
    assert.equal(update.$set?.geo, undefined);
  });

  test(`${method}: explicit removal of both coordinates and geo is preserved`, async (t) => {
    const update = await execute(t, method, { $unset: { coords: 1, geo: 1 } });
    assert.ok(Object.hasOwn(update.$unset, 'coords'));
    assert.ok(Object.hasOwn(update.$unset, 'geo'));
    assert.equal(update.$set?.geo, undefined);
  });

  const invalidUpdates = [
    ['missing longitude', { $set: { coords: { lat: 41 } } }],
    ['missing latitude', { $set: { coords: { lng: -73 } } }],
    ['null coordinates', { $set: { coords: null } }],
    ['undefined coordinates', { $set: { coords: undefined } }],
    ['empty coordinates', { $set: { coords: {} } }],
    ['array coordinates', { $set: { coords: [41, -73] } }],
    ['numeric strings', { $set: { coords: { lat: '41', lng: '-73' } } }],
    ['NaN', { $set: { coords: { lat: NaN, lng: -73 } } }],
    ['infinity', { $set: { coords: { lat: 41, lng: Infinity } } }],
    ['latitude out of bounds', { $set: { coords: { lat: 91, lng: -73 } } }],
    ['longitude out of bounds', { $set: { coords: { lat: 41, lng: -181 } } }],
    ['partial dotted update', { $set: { 'coords.lat': 42 } }],
    ['partial dotted removal', { $unset: { 'coords.lng': 1 } }],
    ['ambiguous parent and child', { $set: { coords, 'coords.lat': 42 } }],
    ['duplicate coordinate assignment', { coords, $set: { coords } }],
    ['relative coordinate change', { $inc: { 'coords.lat': 1 } }],
    ['rename from coordinates', { $rename: { coords: 'oldCoords' } }],
    ['rename into coordinates', { $rename: { oldCoords: 'coords' } }],
    ['mixed coordinate operators', { $set: { coords }, $unset: { coords: 1 } }],
    ['mixed insertion coordinates', { $set: { coords }, $setOnInsert: { coords } }],
    ['conflicting geo removal', { $set: { coords }, $unset: { geo: 1 } }],
    ['conflicting geo assignment', { $unset: { coords: 1 }, $set: { geo } }],
    ['conflicting dotted geo edit', { $set: { coords, 'geo.coordinates': [0, 0] } }],
    ['rename into geography', { $set: { coords }, $rename: { oldGeo: 'geo' } }],
    ['pipeline coordinate update', [{ $set: { coords } }]],
    ['unsupported pipeline syntax', [{ $set: { phone: '555-0100' } }]],
    ['pipeline replacement', [{ $replaceWith: { name: 'Replacement' } }]],
  ];
  for (const [name, input] of invalidUpdates) {
    test(`${method}: rejects ${name} before any database write`, async (t) => {
      const writes = captureCollection(t, method);
      await assert.rejects(Place[method]({ _id: id }, input).exec(), /Invalid Place coordinate update:/);
      assert.equal(writes.length, 0);
    });
  }
}

test('findByIdAndUpdate also runs the geographic safety middleware', async (t) => {
  const writes = captureCollection(t, 'findOneAndUpdate');
  await Place.findByIdAndUpdate(id, { $inc: { 'metrics.impressions': 1 } }).exec();
  assert.equal(writes.length, 1);
  assertNoGeoWrites(writes[0].update);
});
