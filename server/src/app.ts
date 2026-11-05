import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { Db } from './db/pool.js';
import { loadSession, requireAuth } from './auth/middleware.js';
import { csrfProtection } from './http/csrf.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { healthRouter } from './routes/health.js';
import { brandingRouter } from './routes/branding.js';
import { systemRouter } from './routes/system.js';
import { cashRouter } from './routes/cash.js';
import { maintenanceRouter } from './routes/maintenance.js';
import { remindersRouter } from './routes/reminders.js';
import { reportsRouter } from './routes/reports.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { companySettingsRouter } from './routes/companySettings.js';
import { auditLogsRouter } from './routes/auditLogs.js';
import { branchesRouter } from './routes/branches.js';
import { vehiclesRouter } from './routes/vehicles.js';
import { vehicleDocsRouter } from './routes/vehicleDocs.js';
import { customersRouter } from './routes/customers.js';
import { reservationsRouter } from './routes/reservations.js';
import { contractsRouter, contractTemplatesRouter } from './routes/contracts.js';
import { LocalDiskStorage, type FileStorage } from './storage/storage.js';

export interface AppDeps {
  config: AppConfig;
  db: Db;
  logger: Logger;
  storage?: FileStorage;
}

export function createApp({ config, db, logger, storage = new LocalDiskStorage(path.resolve(config.storageDir)) }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          // All assets are self-hosted; no CDN.
          'default-src': ["'self'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'connect-src': ["'self'"],
          'frame-ancestors': ["'none'"],
          'upgrade-insecure-requests': config.cookie.secure ? [] : null,
        },
      },
      // Only send HSTS when actually served over HTTPS.
      strictTransportSecurity: config.cookie.secure ? { maxAge: 15552000 } : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // Request id + access log (method, path without query string, status, duration, user id only).
  app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    const requestId = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    const started = performance.now();
    res.on('finish', () => {
      logger.info(
        {
          requestId,
          method: req.method,
          // Path only: query strings may later carry search terms (customer names), so they are not logged.
          path: req.originalUrl.split('?')[0],
          status: res.statusCode,
          durationMs: Math.round(performance.now() - started),
          userId: res.locals.auth?.user.id,
        },
        'request',
      );
    });
    next();
  });

  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));
  api.use(cookieParser());
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use(csrfProtection(config.appOrigins));
  api.use('/health', healthRouter(db));
  api.use('/branding', brandingRouter(db, storage));
  api.use(loadSession(db, config));
  api.use('/auth', authRouter(db, config));
  api.use('/users', requireAuth, usersRouter(db));
  api.use('/company-settings', requireAuth, companySettingsRouter(db, config, storage));
  api.use('/audit-logs', requireAuth, auditLogsRouter(db));
  api.use('/branches', requireAuth, branchesRouter(db));
  // Raw upload routes come first so the JSON parser never touches file bodies.
  api.use('/vehicles', requireAuth, vehicleDocsRouter(db, config, storage));
  api.use('/customers', requireAuth, customersRouter(db, config, storage));
  api.use('/reservations', requireAuth, reservationsRouter(db));
  api.use('/system', requireAuth, systemRouter(db, config));
  api.use('/cash', requireAuth, cashRouter(db, config, storage));
  api.use('/maintenance', requireAuth, maintenanceRouter(db));
  api.use('/reminders', requireAuth, remindersRouter(db));
  api.use('/reports', requireAuth, reportsRouter(db));
  api.use('/contracts', requireAuth, contractsRouter(db, config, storage));
  api.use('/contract-templates', requireAuth, contractTemplatesRouter(db));
  api.use('/vehicles', requireAuth, vehiclesRouter(db));
  api.use(notFoundHandler);
  app.use('/api', api);

  // Optional: serve the built frontend on the same origin (production on the company host).
  if (config.webDistDir) {
    const dir = path.resolve(config.webDistDir);
    if (existsSync(path.join(dir, 'index.html'))) {
      app.use(express.static(dir, { index: false, maxAge: '1h' }));
      app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dir, 'index.html')));
    } else {
      logger.warn({ dir }, 'WEB_DIST_DIR has no index.html; frontend not served');
    }
  }

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
