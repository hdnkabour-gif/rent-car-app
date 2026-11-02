/**
 * Development-only seed with SYNTHETIC accounts (example.test domain, fictitious company).
 * Guards: NODE_ENV must be exactly "development"; the database must be local and named *_dev or *_test;
 * and it must contain only @example.test accounts. Passwords are randomly generated and shown once.
 */
import { randomBytes } from 'node:crypto';
import { createPool } from '../db/pool.js';
import { hashPassword } from '../auth/password.js';
import { assertSyntheticAccountsOnly, checkDevSeedTarget } from '../db/target-guard.js';

const url = process.env.DATABASE_URL;
const targetErrors = checkDevSeedTarget(url, process.env);
if (targetErrors.length) {
  console.error(`seed:dev refused:\n- ${targetErrors.join('\n- ')}`);
  process.exit(1);
}

const pool = createPool(url!);
const accounts = [
  { email: 'manager@example.test', fullName: 'Gérant Démo', role: 'manager' },
  { email: 'employee@example.test', fullName: 'Employé Démo', role: 'employee' },
];
try {
  // Content check: never touch a database that holds non-synthetic accounts, whatever the env says.
  await assertSyntheticAccountsOnly(pool);
  for (const a of accounts) {
    const password = randomBytes(9).toString('base64url');
    await pool.query(
      `INSERT INTO users (email, full_name, role_code, password_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true,
              failed_login_count = 0, locked_until = NULL`,
      [a.email, a.fullName, a.role, await hashPassword(password)],
    );
    process.stdout.write(`${a.role.padEnd(8)} ${a.email}  password: ${password}\n`);
  }
  await pool.query(
    `UPDATE company_settings SET legal_name = 'Société Démo de Location SARL', trade_name = 'Démo Location',
            city = 'Casablanca' WHERE id = 1 AND legal_name = ''`,
  );
  process.stdout.write('Synthetic demo data ready. Do not use these accounts outside local development.\n');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
