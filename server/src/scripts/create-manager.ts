/**
 * Creates the first manager account (or another manager) from the command line.
 * Usage: npm run create-manager -w server
 * Non-interactive: set FLEETORA_MANAGER_EMAIL, FLEETORA_MANAGER_NAME and FLEETORA_MANAGER_PASSWORD.
 * The password is never printed or logged.
 */
import { createPool, withTransaction } from '../db/pool.js';
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth/password.js';
import { recordAudit } from '../audit/audit.js';
import { emailSchema } from '../routes/schemas.js';
import { ask } from './prompt.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (see server/.env.example)');
  process.exit(1);
}

const email = emailSchema.parse(process.env.FLEETORA_MANAGER_EMAIL || (await ask('Manager email: ')));
const fullName = (process.env.FLEETORA_MANAGER_NAME || (await ask('Full name: '))).trim();
const password = process.env.FLEETORA_MANAGER_PASSWORD || (await ask(`Password (${PASSWORD_MIN_LENGTH}+ characters): `, true));

if (!fullName) {
  console.error('Full name is required');
  process.exit(1);
}
if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
  console.error(`Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`);
  process.exit(1);
}

const pool = createPool(url);
try {
  const hash = await hashPassword(password);
  const id = await withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO users (email, full_name, role_code, password_hash) VALUES ($1, $2, 'manager', $3)
       ON CONFLICT (email) DO NOTHING RETURNING id`,
      [email, fullName, hash],
    );
    if (!rows[0]) throw new Error('A user with this email already exists');
    await recordAudit(tx, {
      action: 'user.create',
      targetType: 'user',
      targetId: rows[0].id,
      metadata: { role: 'manager', via: 'cli' },
    });
    return rows[0].id;
  });
  process.stdout.write(`Manager account created (id ${id}).\n`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
