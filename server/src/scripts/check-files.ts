/** Live integrity check: every stored file exists and matches its checksum.  npm run check-files -w server */
import path from 'node:path';
import pg from 'pg';
import { checkStoredFiles } from '../backup/backup.js';
const say = (s: string) => process.stdout.write(`${s}\n`);

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error('set DATABASE_URL');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
try {
  const problems = await checkStoredFiles(pool, path.resolve(process.env.STORAGE_DIR ?? 'uploads'));
  const n = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM stored_files')).rows[0]!.n;
  if (problems.length) {
    console.error(`${problems.length} of ${n} files have a problem:\n- ${problems.join('\n- ')}`);
    process.exitCode = 2;
  } else say(`All ${n} stored files are present and intact.`);
} finally {
  await pool.end();
}
