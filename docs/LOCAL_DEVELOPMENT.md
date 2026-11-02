# Local development (Windows 11 and Linux)

Target: the current company test PC (Intel Core i5-650, 8 GB RAM, Windows 11). Docker is **not** required.
Use synthetic data only on this machine (see `CLAUDE.md`).

## 1. Install prerequisites (once)

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22 LTS (`.nvmrc`) | https://nodejs.org — the Windows installer adds `node` and `npm` to PATH. |
| PostgreSQL | 16 (14+ works) | Windows installer from postgresql.org (EDB). Install the server and command-line tools; pgAdmin is optional. Keep the default port 5432 and **do not** open it in the Windows firewall. |
| Git | any recent | |

No native build tools are needed: password hashing uses Node's built-in `scrypt`.

## 2. Create the databases (once)

Open **SQL Shell (psql)** from the Start menu, connect as `postgres`, then run (choose your own password):

```sql
CREATE ROLE fleetora LOGIN CREATEDB PASSWORD 'choose-a-local-password';
CREATE DATABASE fleetora_dev  OWNER fleetora;
CREATE DATABASE fleetora_test OWNER fleetora;
```

**How the tests use the database.** `fleetora_test` is only a maintenance connection: the tests never
wipe it. Each test run creates its own brand-new database named `fleetora_run_<random>_test`, uses it,
and drops it at the end, even when tests fail. This is why the `fleetora` role needs `CREATEDB`
(if your role was created without it: `ALTER ROLE fleetora CREATEDB;`).

Safety rules enforced by the code (`server/src/db/target-guard.ts`):
- the test server must be local, the maintenance database name must end in `_test`, and it must differ from `DATABASE_URL`;
- a test run may wipe **only the database it created itself**; `fleetora_dev`, `fleetora_test` or any older database are refused, whatever they contain;
- nothing is cleaned up automatically from earlier runs.

If a run was killed (power cut, closed terminal), a `fleetora_run_…_test` database may be left behind.
It only contains test data; remove it by hand after checking its name:

```sql
SELECT datname FROM pg_database WHERE datname LIKE 'fleetora_run_%_test';
DROP DATABASE fleetora_run_xxxxxxxxxxxx_test;   -- the exact name from the list
```

## 3. Install and configure

PowerShell, from the repository root:

```powershell
npm install
Copy-Item server\.env.example server\.env
notepad server\.env     # set DATABASE_URL and TEST_DATABASE_URL with your local password
```

`server/.env` is git-ignored. Never commit it.

> If your machine has `NODE_ENV=production` set globally, npm skips dev dependencies. Use
> `npm install --include=dev`. Variables already set in the shell take precedence over `server/.env`,
> so also run `$env:NODE_ENV = "development"` (PowerShell) before starting the API.

## 4. Create the schema and the first manager

```powershell
npm run migrate
npm run create-manager -w server     # prompts for email, name and password (hidden)
npm run seed:dev -w server           # optional: fictitious company (2 branches, 8 vehicles, 1 manager, 2 employees);
                                     # prints random passwords once. Refuses unless NODE_ENV=development, a local *_dev/*_test
                                     # database, only @example.test accounts and NO business data at all (no marker can bypass this).
                                     # It never changes a password or reactivates an existing account. To seed again, use a new
                                     # empty development database.
```

## 5. Run in development (two terminals)

```powershell
npm run dev:server    # API on http://127.0.0.1:3000
npm run dev:web       # UI  on http://localhost:5173  (proxies /api to the API)
```

Open http://localhost:5173.

### Testing from a phone on the office Wi-Fi

By default both processes listen on localhost only. For a short test from a phone on the same Wi-Fi,
run `npm run dev:web -- --host` and open `http://<PC-LAN-IP>:5173`, adding that origin to `APP_ORIGINS`
in `server/.env`. This is plain HTTP and is for synthetic data only. Production access uses HTTPS on the
company host and VPN from outside (see `ARCHITECTURE.md`).

## 6. Checks before every commit

```powershell
npm run typecheck
npm run lint
npm test              # server: real PostgreSQL integration tests; web: component tests
npm run build
```

## 7. Production-like local run (single process)

```powershell
npm run build
$env:NODE_ENV="development"; $env:WEB_DIST_DIR="..\web\dist"; npm start -w server
```

`npm run build` deletes the old `server/dist` first and emits nothing if TypeScript reports an error, so a
failed build can never leave stale files to start by mistake. Build with `NODE_ENV` unset or `production`. A development value produces a much larger bundle.
The API then also serves the built UI on http://127.0.0.1:3000. With `NODE_ENV=production`, the server
refuses to start unless `COOKIE_SECURE=true`, so it must be behind HTTPS.

## Resource notes for the 8 GB test PC

- PostgreSQL with default settings and the API (~80 MB RSS) fit comfortably.
- The DB pool is capped at 10 connections.
- One login costs about 32 MiB of RAM for roughly 0.1–0.3 s (scrypt N=2^15). This is deliberate.
