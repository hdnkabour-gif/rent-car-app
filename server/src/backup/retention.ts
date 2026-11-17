/**
 * Backup retention (issue #14): keep the newest backup of each of the last N days, W ISO weeks and
 * M months; never the newest complete backup nor anything younger than `minAgeHours`. Pure planning:
 * deleting is done by the caller, only with an explicit --apply.
 */
export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
  minAgeHours: number;
}
export const DEFAULT_RETENTION: RetentionPolicy = { daily: 14, weekly: 8, monthly: 12, minAgeHours: 48 };

const NAME = /^fleetora-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d{3}))?$/;

export function backupTime(name: string): Date | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!, ms ? +ms : 0));
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export interface RetentionPlan {
  keep: Array<{ name: string; reasons: string[] }>;
  remove: string[];
  ignored: string[];
}

export function planRetention(names: string[], policy: RetentionPolicy = DEFAULT_RETENTION, now = new Date()): RetentionPlan {
  const dated = names
    .map((name) => ({ name, at: backupTime(name) }))
    .filter((x): x is { name: string; at: Date } => x.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime()); // newest first
  const ignored = names.filter((n) => backupTime(n) === null);
  const reasons = new Map<string, string[]>();
  const add = (name: string, why: string) => reasons.set(name, [...(reasons.get(name) ?? []), why]);

  if (dated[0]) add(dated[0].name, 'newest');
  for (const b of dated) if (now.getTime() - b.at.getTime() < policy.minAgeHours * 3600_000) add(b.name, `younger than ${policy.minAgeHours} h`);
  const bucket = (n: number, label: string, key: (d: Date) => string) => {
    const seen = new Set<string>();
    for (const b of dated) {
      const k = key(b.at);
      if (seen.has(k)) continue;
      if (seen.size >= n) break;
      seen.add(k);
      add(b.name, `${label} ${k}`);
    }
  };
  bucket(policy.daily, 'daily', (d) => d.toISOString().slice(0, 10));
  bucket(policy.weekly, 'weekly', isoWeek);
  bucket(policy.monthly, 'monthly', (d) => d.toISOString().slice(0, 7));

  return {
    keep: dated.filter((b) => reasons.has(b.name)).map((b) => ({ name: b.name, reasons: reasons.get(b.name)! })),
    remove: dated.filter((b) => !reasons.has(b.name)).map((b) => b.name),
    ignored,
  };
}

export function retentionFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  const n = (v: string | undefined, def: number, min: number) => {
    if (v === undefined || v === '') return def;
    const x = Number(v);
    if (!Number.isInteger(x) || x < min || x > 1000) throw new Error(`Invalid retention value "${v}" (integer ${min}-1000).`);
    return x;
  };
  return {
    daily: n(env.BACKUP_KEEP_DAILY, DEFAULT_RETENTION.daily, 1),
    weekly: n(env.BACKUP_KEEP_WEEKLY, DEFAULT_RETENTION.weekly, 0),
    monthly: n(env.BACKUP_KEEP_MONTHLY, DEFAULT_RETENTION.monthly, 0),
    minAgeHours: n(env.BACKUP_KEEP_MIN_AGE_HOURS, DEFAULT_RETENTION.minAgeHours, 24),
  };
}
