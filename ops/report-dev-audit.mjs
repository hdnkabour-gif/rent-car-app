#!/usr/bin/env node
/**
 * Prints the development-dependency audit (issue #16) and NEVER fails the build: a registry error, an empty or
 * malformed report only produces a visible warning. The production gate (`npm audit --omit=dev`) is a separate,
 * blocking CI step.   Usage: node ops/report-dev-audit.mjs <audit-dev.json>
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'audit-dev.json';
const doc = 'docs/DEPENDENCY_SECURITY_AUDIT_20261117.md';
const warn = (msg) => console.log(`::warning title=Development-only npm advisories::${msg} (see ${doc})`);

let report;
try {
  report = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  warn(`development audit report unavailable (${e.code === 'ENOENT' ? 'no report file' : 'not valid JSON'}) — re-run npm audit --include=dev`);
  process.exit(0);
}
const v = report && typeof report === 'object' ? report.metadata?.vulnerabilities : undefined;
if (!v || typeof v !== 'object' || typeof v.total !== 'number') {
  const reason = report?.error?.summary || report?.error?.code || report?.message || 'no vulnerability summary in the report';
  warn(`development audit could not be read: ${String(reason).slice(0, 200)}`);
  process.exit(0);
}
console.log(`development audit: ${JSON.stringify(v)}`);
if (v.total > 0) warn(JSON.stringify(v));
process.exit(0);
