"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const { buildHelmetOptions } = require("../src/config/httpSecurityHeaders");

// LAUNCH M1 HOTFIX: local/LAN dev serves plain HTTP only, but helmet's
// defaults send Strict-Transport-Security (HSTS) and CSP's
// upgrade-insecure-requests on every response, including 404s. On some
// mobile HTTP client stacks this can cause the NEXT request to the same
// host to be upgraded to HTTPS, which this dev server never serves —
// breaking every request after the first response, with no obvious link
// back to the original (successful) response that caused it. This
// reproduces exactly the "known barcode works, then everything after
// silently breaks" pattern reported from physical-phone QA.

test("local mode disables HSTS and CSP's upgrade-insecure-requests (plain HTTP dev server)", () => {
  const options = buildHelmetOptions("local");
  assert.equal(options.hsts, false);
  assert.deepEqual(options.contentSecurityPolicy, {
    useDefaults: true,
    directives: { upgradeInsecureRequests: null },
  });
});

test("protected mode keeps full helmet defaults (HSTS included, real HTTPS deployment)", () => {
  const options = buildHelmetOptions("protected");
  assert.equal("hsts" in options, false, "protected mode must not override hsts — real HTTPS deployment keeps the default");
  assert.equal("contentSecurityPolicy" in options, false, "protected mode must not override CSP — keeps the full default");
});

test("crossOriginResourcePolicy is set the same way regardless of mode (unrelated to the HTTP/HTTPS fix)", () => {
  assert.deepEqual(buildHelmetOptions("local").crossOriginResourcePolicy, { policy: "cross-origin" });
  assert.deepEqual(buildHelmetOptions("protected").crossOriginResourcePolicy, { policy: "cross-origin" });
});

test("server.js wires buildHelmetOptions(runtimeSafety.mode) into helmet(), not a hardcoded options object", () => {
  const serverSource = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
  assert.match(serverSource, /const \{ buildHelmetOptions \} = require\("\.\/src\/config\/httpSecurityHeaders"\);/);
  assert.match(serverSource, /app\.use\(helmet\(buildHelmetOptions\(runtimeSafety\.mode\)\)\);/);
});
