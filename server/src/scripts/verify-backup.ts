/** Checks a backup folder byte for byte:  npm run verify-backup -w server -- <folder> */
import { verifyBackup, writeVerifiedReceipt } from '../backup/backup.js';
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
  // --write-receipt: certify this backup for retention (e.g. one made before receipts existed). Never for a backup
  // accepted only through the legacy opt-in, and only after this full, clean verification.
  if (process.argv.includes('--write-receipt')) {
    if (warnings.length) say('No receipt written: the manifest is not authenticated.');
    else {
      await writeVerifiedReceipt(dir);
      say('Verification receipt written (VERIFIED.json): this backup now counts for retention.');
    }
  }
} catch (e) {
  console.error(`verify FAILED: ${(e as Error).message}`);
  process.exit(1);
}
