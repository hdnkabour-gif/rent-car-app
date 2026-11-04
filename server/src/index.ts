import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createPool } from './db/pool.js';
import { createApp } from './app.js';
import { purgeOldSessions } from './auth/sessions.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const db = createPool(config.databaseUrl);
db.on('error', (err) => logger.error({ err: { message: err.message } }, 'PostgreSQL pool error'));

const app = createApp({ config, db, logger });
const server = app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port, env: config.env }, 'Fleetora API listening');
  if (config.env === 'production' && config.storageDirIsDefault) {
    logger.warn('STORAGE_DIR is not set: uploaded files go to ./uploads, which is lost on redeploy. Mount a volume and set STORAGE_DIR.');
  }
});

const housekeeping = setInterval(() => {
  purgeOldSessions(db).catch((err: Error) => logger.warn({ err: { message: err.message } }, 'Session purge failed'));
}, 6 * 3_600_000);
housekeeping.unref();

function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  server.close(() => {
    db.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
