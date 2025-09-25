const express = require('express');
const cors = require('cors');
const path = require('path');
const { CORS_ORIGIN, UPLOAD_DIR } = require('./config/env');
const api = require('./routes');
const error = require('./middlewares/error');

const app = express();

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(path.join(__dirname, '..', UPLOAD_DIR)));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api', api);

// centralized error handler (last)
app.use(error);

module.exports = app;
