/**
 * Backup retention (issue #14). Shows the plan by default; deletes ONLY with --apply.
 *   BACKUP_DIR=... [OFFSITE_KIND=dir|s3 ...] [BACKUP_KEEP_DAILY=14 BACKUP_KEEP_WEEKLY=8 BACKUP_KEEP_MONTHLY=12]
 *     npm run prune-backups -w server [-- --apply]
 * Never deletes the newest complete backup nor any backup younger than BACKUP_KEEP_MIN_AGE_HOURS (48).
 * Off-site: interrupted uploads (no completion marker) older than that age are removed too.
 * If the bucket uses object lock / versioning, deletions may be refused by the provider: that is expected.
 */
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { listOffsite, offsiteFromEnv, removeOffsiteBackup } from '../backup/offsite.js';
import { backupTime, planLocalRetention, planRetention, retentionFromEnv } from '../backup/retention.js';
const say = (s: string) => process.stdout.write(`${s}\n`);

const apply = process.argv.includes('--apply');
try {
  const policy = retentionFromEnv();
  say(`Retention: ${policy.daily} daily, ${policy.weekly} weekly, ${policy.monthly} monthly; never younger than ${policy.minAgeHours} h. ${apply ? 'APPLYING.' : 'Dry run (add --apply to delete).'}`);
  if (process.env.BACKUP_DIR) {
    const root = path.resolve(process.env.BACKUP_DIR);
    // B23-1: only COMPLETE backups take part in retention; failed attempts never protect or displace anything.
    const plan = await planLocalRetention(root, policy);
    const staleFailed = plan.incompleteToRemove;
    say(`Local: ${plan.keep.length + plan.remove.length} complete (keep ${plan.keep.length}, remove ${plan.remove.length}); ${plan.incomplete.length} incomplete (failed attempts; ${staleFailed.length} older than ${policy.minAgeHours} h to clean).`);
    if (plan.keep[0]) say(`  newest complete backup kept: ${plan.keep[0].name}`);
    for (const n of [...plan.remove, ...staleFailed]) {
      say(`  remove ${n}${staleFailed.includes(n) ? ' (incomplete)' : ''}`);
      if (apply) await rm(path.join(root, n), { recursive: true, force: true });
    }
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
