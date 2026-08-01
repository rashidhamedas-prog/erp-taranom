// Central security configuration and password policy.

function validatePassword(pass) {
  const p = String(pass || '');
  if (p.length < 8) return 'رمز باید حداقل ۸ کاراکتر باشد';
  if (p.length > 128) return 'رمز خیلی طولانی است';
  if (!/[a-zA-Z\u0600-\u06FF]/.test(p) || !/\d/.test(p)) {
    return 'رمز باید شامل حرف و عدد باشد';
  }
  return null;
}

/**
 * Return the one explicit JWT secret used by every auth surface.
 * There is deliberately no development/default fallback: a missing secret
 * would make tokens unpredictable across restarts and can silently weaken a
 * production process that was started with an incomplete environment.
 */
function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || '');
  if (!secret) {
    const error = new Error('JWT_SECRET is required');
    error.code = 'E_JWT_SECRET_REQUIRED';
    throw error;
  }
  if (process.env.NODE_ENV === 'production' && secret.length < 32) {
    const error = new Error('JWT_SECRET must contain at least 32 characters in production');
    error.code = 'E_JWT_SECRET_WEAK';
    throw error;
  }
  return secret;
}

function parseAllowedOrigins(raw = process.env.ALLOWED_ORIGINS || '') {
  const isProd = process.env.NODE_ENV === 'production';
  const isDevice = process.env.SYNC_ROLE === 'device';
  const values = String(raw).split(',').map((value) => value.trim()).filter(Boolean);
  const origins = [];

  for (const value of values) {
    let parsed;
    try { parsed = new URL(value); }
    catch {
      const error = new Error(`Invalid ALLOWED_ORIGINS entry: ${value}`);
      error.code = 'E_ALLOWED_ORIGIN_INVALID';
      throw error;
    }
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      const error = new Error(`ALLOWED_ORIGINS entries must be exact origins: ${value}`);
      error.code = 'E_ALLOWED_ORIGIN_INVALID';
      throw error;
    }
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      const error = new Error(`Unsupported ALLOWED_ORIGINS scheme: ${value}`);
      error.code = 'E_ALLOWED_ORIGIN_SCHEME';
      throw error;
    }
    if (isProd && parsed.protocol !== 'https:') {
      const error = new Error(`Production ALLOWED_ORIGINS entries must use HTTPS: ${value}`);
      error.code = 'E_ALLOWED_ORIGIN_HTTPS';
      throw error;
    }
    if (!origins.includes(parsed.origin)) origins.push(parsed.origin);
  }

  // Device builds are same-origin loopback servers. They do not need a remote
  // browser allow-list, but any request that supplies Origin is still denied
  // unless that exact origin was explicitly configured.
  if (isProd && !isDevice && origins.length === 0) {
    const error = new Error('ALLOWED_ORIGINS with at least one explicit HTTPS origin is required in production');
    error.code = 'E_ALLOWED_ORIGINS_REQUIRED';
    throw error;
  }
  return origins;
}

function assertSecurityConfig() {
  getJwtSecret();
  return { allowedOrigins: parseAllowedOrigins() };
}

module.exports = { validatePassword, getJwtSecret, parseAllowedOrigins, assertSecurityConfig };
