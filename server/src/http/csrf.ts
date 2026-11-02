import type { RequestHandler } from 'express';
import { AppError } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'fleetora';

/**
 * CSRF defence in depth (the session cookie is also SameSite=Strict):
 *  1. State-changing requests must carry a custom header. Browsers cannot send custom headers
 *     cross-origin without a CORS preflight, and this API grants no CORS access.
 *  2. If the browser sends an Origin header, it must be one of the configured app origins
 *     or the API's own origin.
 */
export function csrfProtection(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (req.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
      return next(new AppError(403, 'csrf_failed', 'Missing anti-forgery header'));
    }
    const origin = req.get('origin');
    if (origin) {
      const self = `${req.protocol}://${req.get('host')}`;
      if (origin !== self && !allowed.has(origin)) {
        return next(new AppError(403, 'csrf_failed', 'Origin not allowed'));
      }
    }
    next();
  };
}
