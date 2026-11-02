/**
 * Development-only seed with SYNTHETIC accounts (example.test domain, fictitious company).
 * Refuses to run when NODE_ENV=production. Passwords are randomly generated and shown once.
 */
import { randomBytes } from 'node:crypto';
import { createPool } from '../db/pool.js';
import { hashPassword } from '../auth/password.js';

if (process.env.NODE_ENV === 'production') {
  console.error('seed:dev must never run in production');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (see server/.env.example)');
  process.exit(1);
}

const pool = createPool(url);
const accounts = [
  { email: 'manager@example.test', fullName: 'Gérant Démo', role: 'manager' },
  { email: 'employee@example.test', fullName: 'Employé Démo', role: 'employee' },
];
try {
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
} finally {
  await pool.end();
}
