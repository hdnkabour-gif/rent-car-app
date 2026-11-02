# API — Slice 1 (application foundation)

All endpoints are under `/api`. JSON in/out. Errors: `{ "error": { "code", "message", "details?", "requestId" } }`.
State-changing requests (POST/PUT/PATCH/DELETE) must send `X-Requested-With: fleetora`; a browser `Origin`
header, if present, must be the API's own origin or listed in `APP_ORIGINS`. The session is an HttpOnly,
SameSite=Strict cookie (`__Host-fleetora_sid` over HTTPS, `fleetora_sid` on local HTTP).

| Method | Path | Auth / permission | Purpose |
|---|---|---|---|
| GET | `/health` | public | Liveness (`status`, uptime) |
| GET | `/health/db` | public | Database readiness; 503 if unreachable |
| POST | `/auth/login` | public, rate-limited | `{email, password}` → user, permissions, session expiry; sets cookie |
| POST | `/auth/logout` | optional session | Revokes the current session, clears cookie |
| POST | `/auth/logout-all` | session | Revokes all of the user's sessions |
| GET | `/auth/me` | session | Current user, permissions, session expiry |
| PATCH | `/auth/me/preferences` | session | `{preferredLanguage: 'fr'|'ar'}` |
| POST | `/auth/change-password` | session | `{currentPassword, newPassword}`; revokes other sessions |
| GET | `/users` | `users.read` | List staff accounts |
| POST | `/users` | `users.manage` | Create account `{email, fullName, role, password, preferredLanguage?}` |
| PATCH | `/users/:id` | `users.manage` | `{fullName?, role?, isActive?, preferredLanguage?}`; deactivation/role change revokes sessions; last active manager and self-demotion are protected |
| POST | `/users/:id/reset-password` | `users.manage` | `{newPassword}`; unlocks and revokes sessions |
| GET | `/company-settings` | `company_settings.read` | Company identity and document settings |
| PUT | `/company-settings` | `company_settings.update` | Replace editable settings (strict validation; unknown fields rejected) |
| GET | `/audit-logs` | `audit_logs.read` | Newest first; `limit` (≤200), `before` (id), `action`, `actorUserId`, `outcome` |

## Role → permission matrix (migration 0001)

| Permission | Manager | Employee |
|---|---|---|
| `dashboard.view` | ✓ | ✓ |
| `company_settings.read` | ✓ | ✓ |
| `company_settings.update` | ✓ | — |
| `users.read` | ✓ | — |
| `users.manage` | ✓ | — |
| `audit_logs.read` | ✓ | — |

Audited actions: `auth.login` (success/failure with reason), `auth.logout`, `auth.logout_all`,
`auth.password_change`, `authz.denied`, `user.create`, `user.update`, `user.deactivate`,
`user.password_reset`, `company_settings.update` (with field-level before/after).
