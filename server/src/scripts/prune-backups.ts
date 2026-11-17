/**
 * Backup retention (issue #14). Shows the plan by default; deletes ONLY with --apply.
 *   BACKUP_DIR=... [OFFSITE_KIND=dir|s3 ...] [BACKUP_KEEP_DAILY=14 BACKUP_KEEP_WEEKLY=8 BACKUP_KEEP_MONTHLY=12]
 *     npm run prune-backups -w server [-- --apply]
 * Never deletes the newest complete backup nor any backup younger than BACKUP_KEEP_MIN_AGE_HOURS (48).
 * Off-site: interrupted uploads (no completion marker) older than that age are removed too.
 * If the bucket uses object lock / versioning, deletions may be refused by the provider: that is expected.
 */
import path from 'node:path';
import { listOffsite, offsiteFromEnv, removeOffsiteBackup } from '../backup/offsite.js';
import { applyLocalRetention, backupTime, planRetention, retentionFromEnv } from '../backup/retention.js';
const say = (s: string) => process.stdout.write(`${s}\n`);

const apply = process.argv.includes('--apply');
try {
  const policy = retentionFromEnv();
  say(`Retention: ${policy.daily} daily, ${policy.weekly} weekly, ${policy.monthly} monthly; never younger than ${policy.minAgeHours} h. ${apply ? 'APPLYING.' : 'Dry run (add --apply to delete).'}`);
  if (process.env.BACKUP_DIR) {
    const root = path.resolve(process.env.BACKUP_DIR);
    // Only VERIFIED backups take part in retention; failed or unverified ones never protect or displace anything.
    // With --apply, the newest verified backup is verified again in full first; if that fails, nothing is deleted.
    const plan = await applyLocalRetention(root, policy, { apply, passphrase: process.env.BACKUP_PASSPHRASE || undefined });
    const staleFailed = plan.incompleteToRemove;
    say(`Local: ${plan.keep.length + plan.remove.length} verified (keep ${plan.keep.length}, remove ${plan.remove.length}); ${plan.unverified.length} unverified (never deleted here); ${plan.incomplete.length} incomplete (${staleFailed.length} older than ${policy.minAgeHours} h to clean).`);
    if (plan.keep[0]) say(`  newest verified backup kept: ${plan.keep[0].name}`);
    else say('  no verified backup: no verified or unverified backup is deleted.');
    for (const u of plan.unverified) say(`  unverified ${u.name}: ${u.reason}`);
    for (const n of [...plan.remove, ...staleFailed]) say(`  ${apply ? 'removed' : 'remove'} ${n}${staleFailed.includes(n) ? ' (incomplete)' : ''}`);
  }
  const target = offsiteFromEnv();
  if (target) {
    const { complete, incomplete } = await listOffsite(target);
    const plan = planRetention(complete, policy);
    const stale = incomplete.filter((n) => Date.now() - (backupTime(n)?.getTime() ?? Date.now()) > policy.minAgeHours * 3600_000);
    say(`Off-site (${target.kind}): keep ${plan.keep.length}, remove ${plan.remove.length}, interrupted uploads to clean ${stale.length}.`);
    for (const n of [...plan.remove, ...stale]) {
      say(`  remove ${n}`);
      if (apply) await removeOffsiteBackup(target, n);
    }
  }
} catch (e) {
  console.error(`prune FAILED: ${(e as Error).message}`);
  process.exit(1);
}
