import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// B24-2 (gate on PR #24): the CI step that reports development-only advisories must never fail the build.
const script = path.resolve(__dirname, '../../ops/report-dev-audit.mjs');
const dir = mkdtempSync(path.join(tmpdir(), 'fleetora-audit-report-'));
function run(content: string | null) {
  const file = path.join(dir, `audit-${Math.random().toString(16).slice(2)}.json`);
  if (content !== null) writeFileSync(file, content);
  // execFileSync throws on a non-zero exit code: every case below must exit 0.
  return execFileSync(process.execPath, [script, file], { encoding: 'utf8' });
}

describe('development audit reporter (CI, non-blocking)', () => {
  it('a normal report prints the summary and a warning when advisories exist', () => {
    const out = run(JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 12, critical: 0, total: 12 } } }));
    expect(out).toMatch(/development audit: \{"info":0,"low":0,"moderate":0,"high":12,"critical":0,"total":12\}/);
    expect(out).toMatch(/::warning title=Development-only npm advisories::/);
  });

  it('no advisories: summary only, no warning', () => {
    const out = run(JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } }));
    expect(out).toMatch(/"total":0/);
    expect(out).not.toMatch(/::warning/);
  });

  it('npm error reports (registry down, endpoint error) only warn', () => {
    expect(run(JSON.stringify({ error: { code: 'ENOAUDIT', summary: 'Your configured registry does not support audit requests.' } })))
      .toMatch(/::warning .*could not be read: Your configured registry does not support audit requests/);
    expect(run(JSON.stringify({ message: 'request to https://registry.example.invalid failed, reason: getaddrinfo ENOTFOUND', statusCode: 503 })))
      .toMatch(/::warning .*could not be read: request to/);
  });

  it('malformed, empty or missing report files only warn', () => {
    expect(run('not json at all')).toMatch(/::warning .*not valid JSON/);
    expect(run('')).toMatch(/::warning .*not valid JSON/);
    expect(run('null')).toMatch(/::warning .*could not be read/);
    expect(run(null)).toMatch(/::warning .*no report file/);
  });
});
