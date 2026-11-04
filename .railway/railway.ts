import { defineRailway, postgres, project, service } from "railway/iac";

/**
 * Fleetora public demo environment.
 *
 * This file defines one app service and one managed PostgreSQL database.
 * The app is not given a public domain by this file; add the Railway-generated
 * domain only after reviewing the project and then set the APP_ORIGINS shared
 * variable to that exact https:// origin.
 */
export default defineRailway((ctx) => {
  const database = postgres("Fleetora Demo PostgreSQL");

  const app = service("Fleetora Demo App", {
    // Keep development dependencies available: TypeScript and Vite are needed
    // by the production build in this workspace repository.
    build: "npm ci --include=dev && npm run build",

    // The Express server also serves web/dist through WEB_DIST_DIR.
    start: "npm run start -w server",

    // The migration runner is emitted by the server TypeScript build.
    // This runs before each deploy; migrations are forward-only/idempotent.
    preDeploy: "node server/dist/src/scripts/migrate.js",

    // Unauthenticated endpoint that verifies PostgreSQL connectivity without
    // exposing application records or credentials.
    healthcheck: "/api/health/db",
    healthcheckTimeout: 30,

    // Persistent disk for uploaded files, with Railway volume backups (in addition to the
    // application's own verified backups, BACKUP_RESTORE.md).
    volumeMounts: {
      "fleetora-files": { mountPath: "/data", backupSchedules: ["DAILY", "WEEKLY"] },
    },

    env: {
      DATABASE_URL: database.env.DATABASE_URL,
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      COOKIE_SECURE: "true",
      TRUST_PROXY: "true",
      WEB_DIST_DIR: "../web/dist",

      // Uploaded photos and documents live on the persistent volume below, never on the
      // container disk (which is wiped at every deploy).
      STORAGE_DIR: "/data/files",

      // Create this as a Railway *shared environment variable* before running
      // `railway config plan`. After generating the public domain, set it to
      // the exact origin, e.g. https://<generated-domain>.up.railway.app
      APP_ORIGINS: ctx.shared.APP_ORIGINS,
    },
  });

  return project("Fleetora Demo", {
    resources: [database, app],
  });
});
