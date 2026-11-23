import crypto from 'node:crypto';

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function isAuthRequired(config) {
  return Boolean(config.monitorPassword && config.monitorPassword.length > 0);
}

export function isMonitorAuthorized(req, config, options = {}) {
  if (options.bypassAuth) return true;
  if (!isAuthRequired(config)) return true;

  const authHeader = String(req.headers.authorization || '');
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (timingSafeEqualString(token, config.monitorPassword)) {
      return true;
    }
  }

  return false;
}
