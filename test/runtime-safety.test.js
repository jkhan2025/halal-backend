const assert = require('node:assert/strict');
const { test, after, mock } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const net = require('node:net');
const tls = require('node:tls');

const forbidden = [];
const deny = (name) => { forbidden.push(name); throw new Error(`Isolated check forbids ${name}`); };
mock.method(net.Socket.prototype, 'connect', () => deny('network'));
mock.method(tls, 'connect', () => deny('TLS'));
const originalLoad = Module._load;
mock.method(Module, '_load', function (name, ...args) {
  if (/^(mongoose|mongodb|dotenv|@aws-sdk\/|@supabase\/)/.test(name)) return deny('database/cloud/environment module');
  return originalLoad.call(this, name, ...args);
});
for (const target of [fs, fs.promises]) {
  for (const name of ['readFile', 'readFileSync'].filter((key) => typeof target[key] === 'function')) {
    const original = target[name];
    mock.method(target, name, function (file, ...args) {
      if (/^\.env(?:\.|$)/i.test(path.basename(String(file)))) return deny('environment-file read');
      return original.call(this, file, ...args);
    });
  }
}
after(() => { try { assert.deepEqual(forbidden, []); } finally { mock.restoreAll(); } });

const {
  validateRuntime, assertMaintenanceAllowed, assertExternalMaintenanceAllowed, LAN_HOST,
} = require('../src/config/runtimeSafety');
const local = () => ({
  HALAL_RUNTIME_MODE: 'local', HALAL_ALLOW_EXTERNAL_HTTP: '0', HALAL_ALLOW_PROTECTED_SERVICES: '0',
  HOST: '127.0.0.1', PORT: '5051', MONGO_URI: 'mongodb://127.0.0.1:27018/halal_quest_dev',
  STORAGE_DRIVER: 'local', UPLOAD_BASE: '.local/uploads', UPLOAD_DIR: '.local/uploads',
  PUBLIC_BASE_URL: 'http://10.0.2.2:5051', API_KEY: 'synthetic-test-only', ADMIN_KEY: 'synthetic-test-only',
});
const lan = () => ({ ...local(), HALAL_LOCAL_TRANSPORT: 'lan', HALAL_LAN_HOST: LAN_HOST,
  HOST: LAN_HOST, PUBLIC_BASE_URL: `http://${LAN_HOST}:5051` });

test('complete local configuration is pure, isolated, and disables external HTTP', () => {
  const env = local(); const before = { ...env };
  const result = validateRuntime(env);
  assert.equal(result.mode, 'local');
  assert.equal(result.externalHttp, false);
  assert.equal(result.uploadRoot, path.resolve(__dirname, '../.local/uploads'));
  assert.deepEqual(env, before);
});

test('LAN backend accepts only the approved interface while retaining local-only services', () => {
  const env = lan(); const before = { ...env };
  const result = validateRuntime(env);
  assert.equal(result.mode, 'local');
  assert.equal(result.externalHttp, false);
  assert.equal(result.uploadRoot, path.resolve(__dirname, '../.local/uploads'));
  assert.deepEqual(env, before);
});

for (const [name, changes] of [
  ['wildcard LAN bind', { HOST: '0.0.0.0' }],
  ['public LAN bind', { HOST: '8.8.8.8', HALAL_LAN_HOST: '8.8.8.8', PUBLIC_BASE_URL: 'http://8.8.8.8:5051' }],
  ['unapproved private LAN bind', { HOST: '192.168.1.222', HALAL_LAN_HOST: '192.168.1.222',
    PUBLIC_BASE_URL: 'http://192.168.1.222:5051' }],
  ['mismatched LAN host', { HALAL_LAN_HOST: '192.168.1.222' }],
  ['mismatched LAN public URL', { PUBLIC_BASE_URL: 'http://192.168.1.222:5051' }],
  ['LAN loopback bind', { HOST: '127.0.0.1' }],
]) {
  test(`${name} is rejected`, () => {
    assert.throws(() => validateRuntime({ ...lan(), ...changes }), /Development safety:/);
  });
}

test('MongoDB remains on the exact reserved loopback endpoint in localhost and LAN modes', () => {
  const invalidUris = [
    'mongodb://127.0.0.1:27017/halal_quest_dev',
    'mongodb://[::1]:27018/halal_quest_dev',
    `mongodb://${LAN_HOST}:27018/halal_quest_dev`,
    'mongodb://127.0.0.1:27018/other',
  ];
  for (const env of [local(), lan()]) {
    assert.doesNotThrow(() => validateRuntime(env));
    for (const MONGO_URI of invalidUris) {
      assert.throws(() => validateRuntime({ ...env, MONGO_URI }), /reserved loopback development database/);
    }
  }
});

for (const name of ['HALAL_RUNTIME_MODE', 'MONGO_URI', 'STORAGE_DRIVER', 'API_KEY', 'ADMIN_KEY',
  'HOST', 'PORT', 'UPLOAD_BASE', 'UPLOAD_DIR', 'PUBLIC_BASE_URL', 'HALAL_ALLOW_EXTERNAL_HTTP']) {
  test(`missing ${name} fails closed`, () => {
    const env = local(); delete env[name];
    assert.throws(() => validateRuntime(env), /Development safety:/);
  });
}

const unsafe = [
  ['remote MongoDB', { MONGO_URI: 'mongodb+srv://protected.invalid/example' }],
  ['default local database port', { MONGO_URI: 'mongodb://127.0.0.1:27017/halal_quest_dev' }],
  ['other database', { MONGO_URI: 'mongodb://127.0.0.1:27018/existing' }],
  ['credential-bearing URI', { MONGO_URI: 'mongodb://fixture:fixture@127.0.0.1:27018/halal_quest_dev' }],
  ['conflicting Mongo alias', { MONGODB_URI: 'mongodb://protected.invalid/example' }],
  ['public bind', { HOST: '0.0.0.0' }],
  ['unsupported driver value (S3 retired)', { STORAGE_DRIVER: 's3' }],
  ['supabase driver in local mode', { STORAGE_DRIVER: 'supabase' }],
  ['old uploads', { UPLOAD_DIR: 'uploads' }],
  ['escaped uploads', { UPLOAD_BASE: '../uploads' }],
  ['remote public URL', { PUBLIC_BASE_URL: 'https://protected.invalid' }],
  ['external HTTP opt-in', { HALAL_ALLOW_EXTERNAL_HTTP: '1' }],
  ['protected opt-in in local mode', { HALAL_ALLOW_PROTECTED_SERVICES: '1' }],
  ['test runtime startup', { NODE_ENV: 'test' }],
];
for (const [name, changes] of unsafe) {
  test(`${name} is rejected without returning configuration values`, () => {
    assert.throws(() => validateRuntime({ ...local(), ...changes }), (error) => {
      assert.match(error.message, /Development safety:/);
      assert.ok(!error.message.includes('protected.invalid'));
      assert.ok(!error.message.includes('fixture:fixture'));
      return true;
    });
  });
}

for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE',
  'AWS_REGION', 'AWS_ENDPOINT_URL', 'S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY',
  'S3_PUBLIC_BASE', 'S3_ENDPOINT', 'S3_ENABLED', 'CDN_BASE_URL',
  // Supabase Storage (the S3 replacement) gets the exact same treatment —
  // none of these may ever leak into local mode either.
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET', 'SUPABASE_ANON_KEY']) {
  test(`inherited ${name} is rejected in local mode`, () => {
    assert.throws(() => validateRuntime({ ...local(), [name]: 'synthetic-only' }), /Development safety:/);
  });
}

test('explicit cloud-disable flags are allowed locally', () => {
  assert.equal(validateRuntime({ ...local(), S3_ENABLED: '0', AWS_EC2_METADATA_DISABLED: 'true' }).externalHttp, false);
});

// Production evidence photo storage v1: STORAGE_KEY_PREFIX is a new,
// non-secret, non-cloud config value that pass introduced. These two
// tests prove it was not wired in as an accidental new escape hatch.
test('local mode still rejects STORAGE_DRIVER=supabase even when STORAGE_KEY_PREFIX is also set — the prefix must never become a bypass', () => {
  assert.throws(
    () => validateRuntime({ ...local(), STORAGE_DRIVER: 'supabase', STORAGE_KEY_PREFIX: 'prod' }),
    /Development safety:/
  );
});

test('STORAGE_KEY_PREFIX alone does not affect local-mode validation — it is not a cloud/Supabase flag', () => {
  assert.doesNotThrow(() => validateRuntime({ ...local(), STORAGE_KEY_PREFIX: 'irrelevant-locally' }));
});

// S3 -> Supabase Storage provider swap: mirrors the S3_BUCKET/S3_REGION
// required-var tests this file used to have, for the new driver.
test('protected mode with STORAGE_DRIVER=supabase requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_STORAGE_BUCKET', () => {
  const base = {
    ...local(),
    HALAL_RUNTIME_MODE: 'protected',
    HALAL_ALLOW_PROTECTED_SERVICES: '1',
    MONGO_URI: 'mongodb://protected.invalid/example',
    STORAGE_DRIVER: 'supabase',
  };
  assert.throws(() => validateRuntime(base), /Development safety:/, 'missing all three Supabase vars must fail');
  assert.throws(
    () => validateRuntime({ ...base, SUPABASE_URL: 'https://project.supabase.co' }),
    /Development safety:/,
    'missing service-role key and bucket must still fail'
  );
  assert.throws(
    () => validateRuntime({ ...base, SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only' }),
    /Development safety:/,
    'missing bucket must still fail'
  );
  assert.doesNotThrow(() =>
    validateRuntime({
      ...base,
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only',
      SUPABASE_STORAGE_BUCKET: 'halalquest-prod',
    })
  );
});

test('STORAGE_DRIVER=s3 is no longer a valid value anywhere — S3 has been retired in favor of Supabase Storage', () => {
  assert.throws(() => validateRuntime({ ...local(), STORAGE_DRIVER: 's3' }), /STORAGE_DRIVER must be local or supabase/);
  const protectedEnv = {
    ...local(),
    HALAL_RUNTIME_MODE: 'protected',
    HALAL_ALLOW_PROTECTED_SERVICES: '1',
    MONGO_URI: 'mongodb://protected.invalid/example',
    STORAGE_DRIVER: 's3',
  };
  assert.throws(() => validateRuntime(protectedEnv), /STORAGE_DRIVER must be local or supabase/);
});

test('protected mode requires an explicit opt-in and does not default external HTTP on', () => {
  const env = { ...local(), HALAL_RUNTIME_MODE: 'protected', MONGO_URI: 'mongodb://protected.invalid/example' };
  assert.throws(() => validateRuntime(env), /HALAL_ALLOW_PROTECTED_SERVICES/);
  env.HALAL_ALLOW_PROTECTED_SERVICES = '1';
  assert.equal(validateRuntime(env).externalHttp, false);
  env.HALAL_ALLOW_EXTERNAL_HTTP = '1';
  assert.equal(validateRuntime(env).externalHttp, true);
});

test('maintenance remains separately gated and external maintenance is forbidden locally', () => {
  assert.throws(() => assertMaintenanceAllowed(local()), /HALAL_ALLOW_MAINTENANCE/);
  const env = { ...local(), HALAL_ALLOW_MAINTENANCE: '1' };
  assert.equal(assertMaintenanceAllowed(env).mode, 'local');
  assert.throws(() => assertExternalMaintenanceAllowed(env), /external maintenance HTTP is disabled/);
});

test('server, storage, owner and maintenance entrypoints guard before side effects (static only)', () => {
  const files = ['server.js', 'index.js', 'src/lib/storage.js', 'src/routes/owner.routes.js', 'src/config/env.js',
    'seed.js', 'seed-places.js', 'scripts/seed-places.js', 'scripts/fix-geo.js', 'scripts/clear-bad-geo.js',
    'scripts/geocode-place-file.js'];
  for (const file of files) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    const first = source.split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith('//'));
    assert.match(first, /runtimeSafety.*(?:validateRuntime|assertMaintenanceAllowed|assertExternalMaintenanceAllowed)\(\)/, file);
    assert.doesNotMatch(source, /require\(['"]dotenv['"]\)/, file);
  }
  const legacy = fs.readFileSync(path.resolve(__dirname, '../src/routes/index.js'), 'utf8');
  assert.match(legacy.split(/\r?\n/)[1], /^throw new Error\(/);
});

test('OFF helper makes no request in local mode (synthetic VM, no app startup)', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/lib/off.js'), 'utf8');
  let requests = 0;
  const sandbox = {
    module: { exports: {} },
    require(name) {
      if (name === 'axios') return { get() { requests++; throw new Error('Unexpected request'); } };
      if (name === '../config/runtimeSafety') return { validateRuntime: () => validateRuntime(local()) };
      throw new Error('Unexpected dependency');
    },
  };
  vm.runInNewContext(source, sandbox);
  assert.equal(await sandbox.module.exports.fetchFromOFF('synthetic-barcode'), null);
  assert.equal(requests, 0);
});

test('legacy storage cannot initialize AWS in local mode (synthetic VM)', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/lib/storage.js'), 'utf8');
  let awsLoads = 0;
  const sandbox = {
    module: { exports: {} }, process: { env: local() }, console,
    require(name) {
      if (name === '../config/runtimeSafety') return { validateRuntime: () => validateRuntime(local()) };
      if (name === 'fs') return { existsSync: () => true, mkdirSync: () => assert.fail('no filesystem writes allowed') };
      if (name === 'path') return path;
      if (name === 'crypto') return { randomUUID: () => 'synthetic-id' };
      if (name === 'sharp') return () => assert.fail('no image processing allowed');
      if (name.startsWith('@aws-sdk/')) { awsLoads++; throw new Error('Unexpected AWS load'); }
      throw new Error('Unexpected dependency');
    },
  };
  vm.runInNewContext(source, sandbox);
  assert.equal(sandbox.module.exports.isS3Enabled(), false);
  assert.equal(awsLoads, 0);
});

test('npm checks only select isolated tests, not environment loading or the server', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  assert.equal(manifest.scripts.check, 'npm test');
  assert.equal(manifest.scripts.test, 'node --test test/runtime-safety.test.js test/grocery-result-contract.test.js test/trust-foundation.test.js test/restaurant-result-contract-foundation.test.js test/qa-reference-dataset.test.js test/http-security-headers.test.js test/admin-auth.test.js test/submission-moderation.test.js test/reports-rate-limit.test.js test/product-reports.test.js test/storage-key.test.js test/photo-storage.test.js test/signed-photo-url.test.js test/photo-display-urls.test.js test/barcode-equivalence.test.js test/product-search.test.js test/grocery-discovery.test.js test/grocery-detail.test.js test/restaurant-discovery.test.js test/restaurant-result-contract.test.js test/place-geo.test.js');
});
