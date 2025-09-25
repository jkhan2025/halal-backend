const path = require('path');
const fs = require('fs');

const file = path.join(__dirname, '..', 'data', 'groceries.json');

exports.list = (_req, res, next) => {
  fs.readFile(file, 'utf8', (err, raw) => {
    if (err) return next(err);
    try {
      const data = JSON.parse(raw);
      res.json(Array.isArray(data) ? data : []);
    } catch (e) {
      next(e);
    }
  });
};
