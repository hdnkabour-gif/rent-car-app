# Fleetora — npm dependency security audit (2026-11-17, issue #16)

Follows `DEPENDENCY_SECURITY_AUDIT_20261113.md`, which is kept for history.

- **Baseline:** `main` `1e934d3`.
- **Command:** `env -u NODE_ENV npm audit --include=dev` after `npm ci --include=dev`, Node 22.
- **Trap found:** with `NODE_ENV=production` in the shell, a plain `npm audit` silently skips development dependencies and reports **0**. Always pass `--include=dev` for the full inventory.

## Before / after
| | Production (`--omit=dev`) | Full (with dev tools) |
|---|---|---|
| 2026-11-13 (previous report) | 0 | 9 moderate |
| 2026-11-17, before this change | 0 | **15: 8 moderate + 7 high** |
| 2026-11-17, after this change | **0** | **12 high, one single root: `picomatch`, no fix exists** |

## Fixed — `minimatch` < 11.0.1 (moderate, globparts denial of service)
| Package | Before | After | Published |
|---|---|---|---|
| `eslint` | 10.14.0 | **10.15.0** | 2026-11-13 |
| `@eslint/config-array` (via eslint) | 0.23.5 | 0.23.6 (needs `minimatch` ^11.0.5) | 2026-11-13 |
| `typescript-eslint` | 8.72.1 | **8.73.0** (needs `minimatch` ^11.0.1) | 2026-11-16 |
| `minimatch` (resolved) | 10.2.6 | 11.0.9 | 2026-11-16 |
- These are the vendors' own fixed releases. No `overrides`, no `npm audit fix --force`.
- They are **very recent** (published 1 to 4 days before this change): accepted because they are lint-time tools that never ship in the runtime image, and because lint and the full test suites behave the same.
- **Proof:** `eslint .` exit 0 on the whole repository; a deliberate unused variable is still reported; typecheck, server and web tests, and the build pass (see TEST_PLAN, issue #16).

## Not fixable today — `picomatch` ≤ 4.0.7 (high, ReDoS through single-branch repeated extglobs, GHSA-fc5q-39xc-vjpf)
- **No patched release exists:** 4.0.7 (2026-08-24) is the latest, and the advisory covers every version.
- npm's only suggestion, `npm audit fix --force`, would **downgrade Vitest 5 → 3.1.4**, a breaking change that fixes nothing real. **Not done.**
- **Where it is used:** `vite` 8.3.5, `vitest` 5.0.5, `tinyglobby` 0.2.17, `fdir` 6.5.0, and through `tinyglobby` also `typescript-eslint`. All are development, build or lint tools.
- **Exposure (based on the advisory title and on where patterns come from in this repository):**
  - The advisory concerns crafted **glob patterns**. Here every pattern comes from files the developers write: `vite.config.ts`, `vitest.config.ts`, `eslint.config.js`, and the tools' defaults. No user, customer or HTTP input is ever turned into a glob.
  - None of these packages is in the production dependency tree (`npm audit --omit=dev` = 0). The runtime image removes them (`npm prune --omit=dev`, Dockerfile), and production serves the built files through Express, not the Vite dev server.
  - The worst case is a slow lint, test or build run on a developer or CI machine fed a malicious pattern, which requires write access to the repository config.
- **Decision proposed:** accept temporarily, with a re-check rule.
  - CI prints the development audit as a **warning** on every run (non-blocking step).
  - The production gate (`npm audit --omit=dev --audit-level=moderate`) stays **blocking**.
  - When a patched `picomatch` is published, update `vite`, `vitest` and `tinyglobby` (or add a scoped override if their ranges already allow it) in a separate tested change.
  - Re-check at least weekly, and before any release.

This result is time-specific. A zero-advisory production result does not establish complete application security.
