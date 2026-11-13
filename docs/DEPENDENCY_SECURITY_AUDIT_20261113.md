# Fleetora — npm dependency security audit (2026-11-13)

Source: GitHub Actions, Node 22, exact locked dependencies after `npm ci`.
Runs:
- Full inventory: https://github.com/hdnkabour-gif/rent-car-app/actions/runs/43514355203
- Production dependency gate: https://github.com/hdnkabour-gif/rent-car-app/actions/runs/43514560718

## Findings
- `npm audit --omit=dev`: **0 low / 0 moderate / 0 high / 0 critical** known advisories at scan time.
- `npm audit` including dev dependencies: **9 moderate**; 0 high / 0 critical.
- Affected packages are lint/build-time packages: `@eslint/config-array`, `eslint`, `typescript-eslint`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `@typescript-eslint/type-utils`, `@typescript-eslint/typescript-estree`, `@typescript-eslint/utils`, `minimatch`.
- `minimatch`: potential globparts denial of service, GHSA-g3hv-75wg-m249. The audit result does not show a vulnerable production dependency chain.

This result is time-specific; new advisories may appear. A zero-advisory result does not establish complete application security.

## Next actions
1. Maintain a production-dependency audit in CI. Prevent newly vulnerable runtime packages from deploying.
2. Resolve development-only advisories by updating ESLint and TypeScript ESLint as a **separate tested change**, and avoid `npm audit fix --force`. ESLint integrations and major versions require careful compatibility checks.
3. Prune dev dependencies from the shipped runtime Docker image **after building and testing**, then run full CI/Docker regression.
4. Continue manual security tests for authentication, upload validation, authorization and data retention. Advisory scan does not replace application-level threat modeling.
