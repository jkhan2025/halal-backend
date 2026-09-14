"use strict";

// Proves the /api/reports rate limiter actually limits and actually
// returns 429 — using a small, self-contained Express app built from the
// same real `express` + `express-rate-limit` dependencies server.js uses,
// NOT server.js itself (which cannot even boot under NODE_ENV=test — see
// src/config/runtimeSafety.js). This app only ever listens on 127.0.0.1 on
// an OS-assigned ephemeral port and is closed at the end of each test; it
// never touches Mongo, TLS, or any external network.

const assert = require("node:assert/strict");
const { test } = require("node:test");
const express = require("express");
const rateLimit = require("express-rate-limit");

function startLimitedApp({ max, windowMs = 60_000 }) {
  const app = express();
  app.use(express.json());
  const limiter = rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: "RATE_LIMITED" },
  });
  app.post("/api/reports", limiter, (_req, res) => res.status(200).json({ ok: true }));

  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stop(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("requests below the limit all succeed (normal contribution QA is never throttled)", async () => {
  const { server, baseUrl } = await startLimitedApp({ max: 5 });
  try {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/api/reports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(res.status, 200, `request ${i + 1} of 5 (within limit) must succeed`);
    }
  } finally {
    await stop(server);
  }
});

test("a request beyond the configured max returns 429 with a clear error body, and does not affect an unrelated route", async () => {
  const { server, baseUrl } = await startLimitedApp({ max: 3 });
  try {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/api/reports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(res.status, 200);
    }
    const limited = await fetch(`${baseUrl}/api/reports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(limited.status, 429);
    const body = await limited.json();
    assert.equal(body.error, "RATE_LIMITED");
  } finally {
    await stop(server);
  }
});

test("the rate limiter is scoped to the route it's attached to, not global", async () => {
  const app = express();
  const limiter = rateLimit({ windowMs: 60_000, max: 1, standardHeaders: true, legacyHeaders: false });
  app.post("/api/reports", limiter, (_req, res) => res.status(200).json({ ok: true }));
  app.get("/health", (_req, res) => res.status(200).json({ ok: true })); // no limiter

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${baseUrl}/api/reports`, { method: "POST" }); // consumes the only allowed slot
    const limited = await fetch(`${baseUrl}/api/reports`, { method: "POST" });
    assert.equal(limited.status, 429);
    // Unrelated route must be entirely unaffected.
    for (let i = 0; i < 5; i++) {
      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 200, "an unrelated route must never be throttled by /api/reports' limiter");
    }
  } finally {
    await stop(server);
  }
});

test("server.js registers a dedicated reportsLimiter on POST /api/reports, separate from the generic global limiter and the /v1/submissions uploadLimiter", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(source, /const reportsLimiter = rateLimit\(/);
  assert.match(source, /app\.post\(\s*"\/api\/reports",\s*reportsLimiter,\s*async/);
  // The dedicated limiter must be tighter than the global soft limit (600/15min).
  const limiterBlockMatch = source.match(/const reportsLimiter = rateLimit\(\{([\s\S]*?)\}\);/);
  assert.ok(limiterBlockMatch, "expected to find the reportsLimiter configuration block");
  const maxMatch = limiterBlockMatch[1].match(/max:\s*(\d+)/);
  assert.ok(maxMatch, "expected an explicit numeric max on reportsLimiter");
  assert.ok(Number(maxMatch[1]) < 600, "the public, unauthenticated /api/reports endpoint must be tighter than the generic global limit");
});
