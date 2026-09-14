"use strict";

// Proves the moderation admin-key gate (src/config/adminAuth.js) fails
// CLOSED: missing configuration must never fall through to `next()` the
// way server.js's older requireApiKey does for the optional /v1/submissions
// gate. Pure unit tests against fake req/res/next objects — no Express
// app, no server.js, no network/database of any kind.

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRequireAdminKey, safeEqual } = require("../src/config/adminAuth");

function fakeReqRes(headerValue) {
  const state = { status: null, body: null, nextCalled: false };
  const req = { header: (name) => (name.toLowerCase() === "x-admin-key" ? headerValue : undefined) };
  const res = {
    status(code) {
      state.status = code;
      return this;
    },
    json(body) {
      state.body = body;
      return this;
    },
  };
  const next = () => {
    state.nextCalled = true;
  };
  return { req, res, next, state };
}

test("safeEqual is a plain constant-time-ish equality check", () => {
  assert.equal(safeEqual("secret", "secret"), true);
  assert.equal(safeEqual("secret", "wrong"), false);
  assert.equal(safeEqual("secret", "secret-but-longer"), false);
  // safeEqual itself is a general-purpose compare (equal empty strings are
  // "equal"); refusing an empty CONFIGURED key is createRequireAdminKey's
  // own job, enforced by the fail-closed test below, before safeEqual is
  // ever reached.
});

test("FAIL CLOSED: when no admin key is configured (undefined/empty/whitespace), the middleware always rejects — it never calls next()", () => {
  for (const configured of [undefined, "", "   ", null]) {
    const middleware = createRequireAdminKey(configured);
    const { req, res, next, state } = fakeReqRes("anything");
    middleware(req, res, next);
    assert.equal(state.nextCalled, false, `must not call next() when ADMIN_KEY is ${JSON.stringify(configured)}`);
    assert.equal(state.status, 503);
    assert.equal(state.body.error, "MODERATION_UNAVAILABLE");
  }
});

test("missing header is rejected (401) even when a real admin key IS configured", () => {
  const middleware = createRequireAdminKey("real-secret-123");
  const { req, res, next, state } = fakeReqRes(undefined);
  middleware(req, res, next);
  assert.equal(state.nextCalled, false);
  assert.equal(state.status, 401);
  assert.equal(state.body.error, "UNAUTHORIZED");
});

test("wrong key is rejected (401)", () => {
  const middleware = createRequireAdminKey("real-secret-123");
  const { req, res, next, state } = fakeReqRes("wrong-guess");
  middleware(req, res, next);
  assert.equal(state.nextCalled, false);
  assert.equal(state.status, 401);
  assert.equal(state.body.error, "UNAUTHORIZED");
});

test("correct key is accepted — next() is called and no status/body is set by the middleware itself", () => {
  const middleware = createRequireAdminKey("real-secret-123");
  const { req, res, next, state } = fakeReqRes("real-secret-123");
  middleware(req, res, next);
  assert.equal(state.nextCalled, true);
  assert.equal(state.status, null);
});

test("the configured key is trimmed, but the PROVIDED header value is not — accidental leading/trailing whitespace in the header must not match", () => {
  const middleware = createRequireAdminKey("  real-secret-123  ");
  const ok = fakeReqRes("real-secret-123");
  middleware(ok.req, ok.res, ok.next);
  assert.equal(ok.state.nextCalled, true);

  const withWhitespace = fakeReqRes(" real-secret-123 ");
  middleware(withWhitespace.req, withWhitespace.res, withWhitespace.next);
  assert.equal(withWhitespace.state.nextCalled, false);
});

test("never echoes the configured secret back in any response body", () => {
  const middleware = createRequireAdminKey("super-secret-value");
  const { req, res, next, state } = fakeReqRes("wrong");
  middleware(req, res, next);
  assert.equal(JSON.stringify(state.body).includes("super-secret-value"), false);
});
