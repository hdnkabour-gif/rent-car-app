# Contributor Instructions

## Branch and release safety
- Never commit, push, merge, or rebase directly onto `main`.
- Work only on a task-specific branch created from the agreed project baseline.
- Do not modify another contributor's active branch. Check the current branch and latest commit before editing.
- Do not force-push or rewrite shared history.
- Do not merge or deploy unless the repository owner explicitly approves it.
- Keep commits focused and explain exactly which files changed.

## Truthful reporting
- Never claim that code, tests, migrations, backups, security checks, or deployment succeeded unless they were actually run and their results were observed.
- Distinguish implemented, tested, accepted, and deferred work.
- Report skipped tests and known limitations explicitly.

## Data protection
- Never commit real customer documents, identity details, vehicle registration documents, production exports, passwords, tokens, private keys, or production database dumps.
- Use synthetic fixtures or minimized, consented test samples.
- Keep secrets in environment variables or an approved secret manager. Commit only safe placeholders in `.env.example`.
- Preserve original uploaded documents. Do not log document contents or sensitive OCR values.
- Do not send personal documents to an external OCR provider without a documented privacy/security review and company approval.

## Product scope
- This is an internal Moroccan car-rental operations system, not a public booking marketplace.
- Preserve all accepted requirements and deferred roadmap items. Do not silently delete or narrow scope.
- Manager/employee permissions must be enforced by the backend/API, not only by the UI.
- Deposits are not rental revenue. Financial corrections must be traceable.
- OCR output is a suggestion and requires authorized human review before becoming verified data.
- The paper contract signed by the parties remains the official contract for the initial release. PDF is for preview, printing and archiving; electronic signature is not in the initial scope.
- Initial WhatsApp reminders use a prefilled `wa.me` link. An employee checks and sends the message manually. Do not implement automated sending or WhatsApp Business API in the initial release.

## Engineering standards
- Use versioned database migrations; never make undocumented destructive schema changes.
- Validate uploads by size, allowed extension, detected content type and file signature where feasible. Generate random storage names; never trust client paths or filenames.
- Keep file storage behind an adapter so local storage can later be replaced without changing business logic.
- Keep OCR behind a replaceable service adapter.
- Add tests for authorization, reservation conflicts, financial calculations, uploads and document review.
- Update `FEATURE_TRACKER.md`, `CHANGELOG.md` and relevant architecture/decision documents when scope or status changes.
- Do not add external CDN dependencies for essential application assets.
- Do not introduce production hosting, public exposure, or external integrations without explicit approval.
