/** Checks a backup folder byte for byte:  npm run verify-backup -w server -- <folder> */
import { verifyBackup } from '../backup/backup.js';
const say = (s: string) => process.stdout.write(`${s}\n`);

const dir = process.argv[2];
if (!dir) {
  console.error('usage: verify-backup <backup folder>');
  process.exit(1);
}
try {
  const { manifest, problems } = await verifyBackup(dir);
  say(`Backup of ${manifest.database} made ${manifest.createdAt}: ${manifest.files.length} files.`);
  if (problems.length) {
    console.error(`NOT INTACT (${problems.length}):\n- ${problems.join('\n- ')}`);
    process.exit(2);
  }
  say('Intact: database dump and every file match the manifest.');
} catch (e) {
  console.error(`verify FAILED: ${(e as Error).message}`);
  process.exit(1);
}
