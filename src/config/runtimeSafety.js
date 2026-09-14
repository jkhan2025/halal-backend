// Pure configuration validation: never load dotenv, connect, or create files here.
const path = require('node:path');
const BACKEND_ROOT = path.resolve(__dirname, '../..');
const LOCAL_TRANSPORT = 'localhost';
const LAN_TRANSPORT = 'lan';
const LAN_HOST = '192.168.1.221';

function fail(message) {
  throw new Error(`Development safety: ${message}`);
}

function required(env, name) {
  if (!env[name] || !String(env[name]).trim()) fail(`${name} must be explicitly configured`);
  return String(env[name]);
}

function localHttpUrl(value, port, transport) {
  try {
    const url = new URL(value);
    const approvedHost = transport === LAN_TRANSPORT
      ? url.hostname === LAN_HOST
      : ['127.0.0.1', '[::1]', '10.0.2.2'].includes(url.hostname);
    return url.protocol === 'http:' && approvedHost &&
      url.port === String(port) && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function validateRuntime(env = process.env) {
  const mode = required(env, 'HALAL_RUNTIME_MODE');
  if (!['local', 'protected'].includes(mode)) fail('HALAL_RUNTIME_MODE must be local or protected');
  if (env.NODE_ENV === 'test') fail('application startup is disabled during isolated tests');
  if (mode === 'protected' && env.HALAL_ALLOW_PROTECTED_SERVICES !== '1') {
    fail('protected services require HALAL_ALLOW_PROTECTED_SERVICES=1 and separate owner approval');
  }

  const mongoUri = required(env, 'MONGO_URI');
  if (env.MONGODB_URI && env.MONGODB_URI !== mongoUri) fail('MONGO_URI and MONGODB_URI conflict');
  const storageDriver = required(env, 'STORAGE_DRIVER');
  if (!['local', 'supabase'].includes(storageDriver)) fail('STORAGE_DRIVER must be local or supabase');
  required(env, 'API_KEY');
  required(env, 'ADMIN_KEY');

  if (mode === 'local') {
    const transport = env.HALAL_LOCAL_TRANSPORT || LOCAL_TRANSPORT;
    if (![LOCAL_TRANSPORT, LAN_TRANSPORT].includes(transport)) {
      fail('local transport must be localhost or lan');
    }
    // This address reserves a NEW isolated instance; it does not prove that a
    // currently running loopback service or database is safe to use.
    if (!/^mongodb:\/\/127\.0\.0\.1:27018\/halal_quest_dev$/.test(mongoUri)) {
      fail('local MONGO_URI must target the reserved loopback development database on port 27018');
    }
    if (env.PORT !== '5051') fail('local backend requires PORT=5051');
    if (transport === LAN_TRANSPORT) {
      if (env.HALAL_LAN_HOST !== LAN_HOST || env.HOST !== LAN_HOST) {
        fail('LAN backend requires the exact approved private interface');
      }
    } else {
      if (env.HALAL_LAN_HOST) fail('LAN host is forbidden in localhost mode');
      if (!['127.0.0.1', '::1'].includes(env.HOST)) fail('localhost backend requires a loopback HOST');
    }
    if (storageDriver !== 'local') fail('Cloud storage is forbidden in local mode');
    if (env.UPLOAD_BASE !== '.local/uploads' || env.UPLOAD_DIR !== '.local/uploads') {
      fail('local UPLOAD_BASE and UPLOAD_DIR must both be .local/uploads');
    }
    if (!localHttpUrl(env.PUBLIC_BASE_URL, env.PORT, transport)) {
      fail(transport === LAN_TRANSPORT
        ? 'LAN PUBLIC_BASE_URL must match the exact approved private interface'
        : 'PUBLIC_BASE_URL must use the local development API');
    }
    if (env.HALAL_ALLOW_EXTERNAL_HTTP !== '0') fail('local mode requires HALAL_ALLOW_EXTERNAL_HTTP=0');
    if (env.HALAL_ALLOW_PROTECTED_SERVICES && env.HALAL_ALLOW_PROTECTED_SERVICES !== '0') {
      fail('protected-service opt-in is forbidden in local mode');
    }
    const remoteSetting = Object.keys(env).find((name) =>
      /^(AWS_|S3_|SUPABASE_|CDN_BASE_URL$)/.test(name) && env[name] &&
      !(name === 'S3_ENABLED' && env[name] === '0') &&
      !(name === 'AWS_EC2_METADATA_DISABLED' && env[name] === 'true')
    );
    if (remoteSetting) fail(`remove ${remoteSetting} from the local process environment`);
  } else if (storageDriver === 'supabase') {
    required(env, 'SUPABASE_URL');
    required(env, 'SUPABASE_SERVICE_ROLE_KEY');
    required(env, 'SUPABASE_STORAGE_BUCKET');
  }

  return Object.freeze({
    mode,
    uploadRoot: path.resolve(BACKEND_ROOT, mode === 'local' ? '.local/uploads' : (env.UPLOAD_DIR || env.UPLOAD_BASE || 'uploads')),
    externalHttp: mode === 'protected' && env.HALAL_ALLOW_EXTERNAL_HTTP === '1',
  });
}

function assertMaintenanceAllowed(env = process.env) {
  const config = validateRuntime(env);
  if (env.HALAL_ALLOW_MAINTENANCE !== '1') fail('maintenance requires HALAL_ALLOW_MAINTENANCE=1 and separate owner approval');
  return config;
}

function assertExternalMaintenanceAllowed(env = process.env) {
  const config = assertMaintenanceAllowed(env);
  if (!config.externalHttp) fail('external maintenance HTTP is disabled');
  return config;
}

module.exports = {
  validateRuntime, assertMaintenanceAllowed, assertExternalMaintenanceAllowed,
  LOCAL_TRANSPORT, LAN_TRANSPORT, LAN_HOST,
};
