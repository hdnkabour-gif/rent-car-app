import { pino, type Logger } from 'pino';

/**
 * Structured logger. Request bodies, cookies, auth headers and query strings are never logged.
 * The redact list is a second line of defence in case an object is logged by mistake.
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'fleetora-api' },
    redact: {
      paths: [
        'password',
        '*.password',
        'newPassword',
        '*.newPassword',
        'password_hash',
        '*.password_hash',
        'token',
        '*.token',
        'token_hash',
        '*.token_hash',
        'cookie',
        '*.cookie',
        'headers.cookie',
        'headers.authorization',
        'req.headers.cookie',
        'req.headers.authorization',
        'databaseUrl',
        '*.databaseUrl',
      ],
      censor: '[REDACTED]',
    },
  });
}
