/** Checks a backup folder byte for byte:  npm run verify-backup -w server -- <folder> */
import { verifyBackup } from '../backup/backup.js';
const say = (s: string) => process.stdout.write(`${s}\n`);

const dir = process.argv[2];
if (!dir) {
  console.error('usage: verify-backup <backup folder>');
  process.exit(1);
}
try {
  const allow = process.env.BACKUP_ALLOW_UNAUTHENTICATED_LEGACY === 'true';
  const { manifest, problems, warnings } = await verifyBackup(dir, process.env.BACKUP_PASSPHRASE || undefined, { allowUnauthenticatedLegacy: allow });
  say(`Backup of ${manifest.database} made ${manifest.createdAt}: ${manifest.files.length} files.`);
  for (const w of warnings) console.warn(`WARNING: ${w}`);
  if (problems.length) {
    console.error(`NOT INTACT (${problems.length}):\n- ${problems.join('\n- ')}`);
    process.exit(2);
  }
  say(warnings.length ? 'Contents match the manifest, but the manifest itself is NOT authenticated (see warning).' : 'Intact and authentic: database dump and every file match the authenticated manifest.');
} catch (e) {
  console.error(`verify FAILED: ${(e as Error).message}`);
  process.exit(1);
}
