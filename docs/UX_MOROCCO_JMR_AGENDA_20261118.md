# JMR LUXE CAR — Moroccan UX & Brand Audit (18 November 2026)

## Scope
An implementation audit, not a picture gallery. The reference mockups from this conversation describe a black/silver/chrome luxury automotive identity, a full logo/name staged intro, and a day-by-day action timeline with colored rental events. This branch implements **real interactive UI** and real permission-scoped event data; no screenshot is substituted for functionality.

## Observed baseline (main 0a7d6bc6)
- `DashboardPage` displayed an oversized brand hero, 5 quick-action buttons, `FleetOverview`, document/maintenance/customer/contract/reservation summaries, warnings: too many blocks before a novice operator sees the next task.
- Existing `jmr-lockup.svg` had simplified flat lines rather than layered chrome speculars; startup splash stopped as soon as `/auth/me` returned, often before the logo even loaded, and first dashboard data then popped in separately.
- Branding, FR/AR translations, responsive bottom navigation, private photo serving, real rental ledger, source-of-truth branch permissions already existed and are preserved. No parallel data system needed.

## Decisions implemented in this isolated branch
1. **Readable, task-first home:** JMR black/charcoal silver cockpit, consistent header/bottom navigation; an agenda dominates, with date/week picker, Casablanca clock, simple quick actions, and four compact totals. Business data come from the real DB, never from the example vehicles/amounts in a mockup.
2. **Operational event semantics:** confirmed reservations, actual checkouts, planned returns & late open contracts, outstanding **rental only** (payments less valid reversals; excludes deposits), maintenance by actual date, vehicle documents due/expired. Time/date normalized to Africa/Casablanca; amounts integer centimes MAD.
3. **Simple language and huge touch targets:** FR-MA and Arabic (RTL) with Latin numerals for dates & money; direct nouns/verbs, expandable advanced cards, obvious empty/error/retry states. Color has icon/text redundancies; icons never the only signifier.
4. **Protected details:** the server filters every branch-owned record with `branchFilter`; customer names require `customers.read`; money events require `cash.read`; unauthorized event types are omitted. No new financial mutation endpoints.
5. **Authentic photos:** only attached vehicle images from the **same authorized vehicle**, via the existing secured `/api/vehicles/:id/files/:fileId` endpoint. A vector car icon is used if no photo exists; no stock photos or invented car models or facts.
6. **Chrome identity:** original layered metallic vector shield with reflective curves and sedan/coupe profile under `/branding/jmr-premium-crest.svg`; fully scalable. This is intentionally an original SVG implementation and **not a claim of a pixel-identical photorealistic render**. A production-ready raster rendition may later replace it with an owner's approved file.
7. **Boot sequence:** session and branding init, fully loaded logo image, explicit company name reveal, and initial authenticated agenda preload. No fake 72% indicator. A bounded logo wait prevents being trapped if an image stalls. The boot never blocks the public guest document intake. Other agencies retain uploaded branding and their base light styles.
8. **Performance:** the existing secondary reports mount only when opened; agenda preload shares a 15s user/date-scoped cache. No unbounded local storage of private data; no new external JS/CDN or tracking.

## Page-by-page usability audit — next waves, not misrepresented as shipped
- **Reservations:** task guidance at each stage; prevent duplicate bookings; highlight dates/prices/vehicle availability in MAD and agency time zone. Keep existing confirmation and validation.
- **Vehicles:** status, plate, real vehicle photo, return due, document alerts; clearly distinguish 'available' from 'pending inspection'; no fake stock images.
- **Contracts:** step-by-step checkout/check-in; manager-approved late fee; display amounts and deposit separately; never interpret a payment reminder as money received.
- **Customers/OCR:** big camera/upload actions, field confidence, human review before saving, no exposure of private IDs in timeline.
- **Cash/expenses:** integer centime calculations, audit trails, company branch scoping, explicitly labeled due vs collected.
- **Infractions:** human-reviewed contract matching, no auto charge and no unauthorised NARSA API.
- **Mobile/accessibility:** contrast check for all statuses, 44px+ touch targets, safe-area notch spacing, zoom and large font support, RTL long text, keyboard and reduced-motion tests. This branch prioritizes the home and global shell; full details require separate patches and visual QA.

## Release gates
- Tests: backend synthetic branch scoping, invalid day and zero data; UI agenda with FR/AR and no invented images; existing auth/brand/OCR tests. CI lint/typecheck/build/migration audit.
- Stage exact SHA on OCR Staging with synthetic data; verify Railway DB healthcheck and logs. Check in real mobile browsers manually because CI/healthchecks alone do not verify pixel-level appearance.
- **Do not** approve real customer file storage while encrypted external backups, a restore proof, legal CNDP review, and financial issue RC-03 are unfinished. This is not a 'zero-risk' redesign.
