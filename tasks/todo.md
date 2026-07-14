# QuickShare Optimization Implementation Plan

Status: approved on 2026-07-14. Implementation in progress.

Baseline reviewed: GitHub `main` commit `b3c15be67c93fc76e8ae047e82017f726d9cee12` and its current Vercel production deployment.

## Agreed operating rules

- [ ] Keep PostgreSQL durable data as the source of truth. Browser, CDN, rendered output, and runtime caches are disposable derived layers only.
- [ ] One work package per focused commit/PR; do not mix security, UI, performance, and product-schema refactors.
- [ ] Add a failing regression test before each correctness/security fix.
- [ ] Verify each package locally, in CI, on a preview deployment, and on production before continuing.
- [ ] Preserve backward compatibility for existing share URLs and `/api/v1/share` unless explicitly approved otherwise.
- [ ] Use additive/compatible database migrations; deploy schema before code that requires it.
- [ ] Do not rewrite Express/EJS, introduce an ORM, add Redis/KV as truth, or split services.

## Approved decisions

- [x] Expired or revoked public shares return `410 Gone`; admin pages can still inspect expired records.
- [x] Creation offers two access modes: “持有链接可访问” and “密码保护”. No public discovery/feed is added.
- [x] Generated passwords keep the existing 6-digit numeric behavior.
- [x] Custom passwords are 4–12 characters and accept only ASCII letters, digits, and this explicit symbol allowlist: `!@#$%^&*()_+-=.,?~`.
- [x] The server is authoritative for custom-password validation; homepage, admin, and API clients mirror the same rule for immediate feedback.
- [x] View counts are approximate product analytics, not billing-grade counters; they must not block page rendering.
- [x] The share body limit is chosen from production size distribution before rollout: use 2 MB if current data fits; otherwise set the smallest safe limit above observed p99, capped initially at 5 MB.
- [x] Phases 0–3 are the initial optimization program. Phase 4 versioning starts only after a separate product gate.

## Phase 0 — Safety gate

### WP0: CI baseline

- [x] Add `.github/workflows/ci.yml` for `npm ci && npm test` on PRs and `main` pushes.
- [x] Keep CI on the in-memory repository; never inject production database credentials.
- [x] Record the current test result before runtime changes: `33/33` passed; after the repository-isolation guard, `34/34` passed.
- [x] Make `NODE_ENV=test` select `MemoryPageRepository` even if database URLs leak into the process environment.

Verify:

1. Open a test PR -> CI runs the full Node test suite.
2. Introduce a controlled failing assertion -> CI becomes red.
3. Restore the assertion -> CI returns green.

Rollback: workflow-only commit; no runtime or data effect.

## Phase 1 — Trust, security, and lifecycle correctness

### WP1: Remove admin stored-XSS path and complete dashboard CSRF

Files expected: `views/admin-page-detail.ejs`, admin views, `public/js/admin.js`, `public/js/admin-detail.js`, `app.js`, route tests.

- [x] Replace raw inline `JSON.stringify` script injection with safe JSON serialization that escapes `<`, `>`, `&`, U+2028, and U+2029, using a non-executable `application/json` data block.
- [x] Pass a dashboard CSRF token to every admin mutation page.
- [x] Add `requireDashboardCsrf` to update, delete, batch-delete, clone, and any other dashboard mutation.
- [x] Send `X-CSRF-Token` from all corresponding admin scripts.
- [x] Add regression payloads containing `</script><script>`, quotes, Unicode separators, and HTML content.

Verify:

1. Open the malicious page in admin detail -> no script executes and preview still works inside the sandbox.
2. Call each admin mutation without/with a wrong CSRF token -> `403`.
3. Call each mutation with the valid token -> existing behavior succeeds.

Rollback: application-only; no schema change.

### WP2: Enforce expiration consistently

Files expected: `models/postgres-pages.js`, `models/memory-pages.js`, `app.js`, new `test/view-routes.test.js`.

- [x] Add `getPublicById(id, now)` to both repositories; keep `getById` for admin use.
- [x] Use the public method in `/view/:id`, `/view/:id/password`, and public metadata routes.
- [x] Treat `expires_at <= now` as expired and return `410` with a generic message.
- [x] Keep expired rows visible and editable in admin; do not auto-delete them.

Verify:

1. No expiry and future expiry -> view works.
2. One millisecond before expiry -> view works.
3. At and after expiry -> view, password validation, and metadata all return `410`.
4. Admin detail for the expired row -> still works.

Rollback: application-only; existing `expires_at` data is untouched.

### WP3: Make access policy atomic at creation time

Files expected: `views/index.ejs`, `public/js/main.js`, `app.js`, `views/password.ejs`, create/view tests.

- [x] Move access mode, password, Markdown theme, title, description, and expiry controls before the publish button.
- [x] Keep a single-page flow; do not introduce a wizard.
- [x] Send all policy fields in the initial create request so no share is briefly public.
- [x] Add the same validated fields to `/api/v1/share` while preserving existing clients.
- [x] Keep generated passwords on the current 6-digit numeric path; do not change `DEFAULT_PASSWORD_LENGTH` or automatic generation behavior.
- [x] Replace the PIN-only access UI with a labelled conventional password field so it can unlock both generated numeric and allowed custom passwords.
- [x] Add one shared server-side custom-password validator for 4–12 characters using `[A-Za-z0-9!@#$%^&*()_+\-=.,?~]`; use the same rule in homepage, admin, and API flows.
- [x] Reject whitespace, non-ASCII letters, emoji, and symbols outside the explicit allowlist with a clear validation error.
- [x] Change “此内容已加密” to “此内容受密码保护”.
- [x] Preserve user input/settings after server or network failure and prevent duplicate submissions.

Verify:

1. Create a protected share while observing requests -> exactly one create request, and the stored row is protected from insertion onward.
2. Generated protection -> password remains exactly 6 numeric digits.
3. Custom-password boundaries and every allowed/rejected character class -> homepage, admin, and API agree.
4. Create with title, description, theme, password, and expiry -> public/admin/API views agree.
5. Wrong password, network failure, and successful unlock -> distinct accessible states.

Rollback: UI and compatible API changes in one package; no destructive migration.

### WP4: Request boundaries, rate limits, and baseline headers

Files/config expected: `app.js`, `config.js`, `.env.example`, `docs/deployment.md`, Vercel Firewall/WAF, security tests.

- [ ] Replace the global 15 MB parser with route-appropriate limits: small auth/form limits and the approved share-content limit.
- [ ] Add edge rate limits for `/login`, `/admin/login`, `/view/:id/password`, `/api/pages/create`, and `/api/v1/share`; do not use an in-process Map as reliable limiter state.
- [ ] Start with monitored conservative thresholds and tune from 429/error data.
- [ ] Disable `x-powered-by`; add `X-Content-Type-Options` and `Referrer-Policy`.
- [ ] Mark login, admin, password, and protected responses `private, no-store`.
- [ ] Delay strict CSP until inline scripts and unnecessary third-party admin scripts are removed in Phase 3.

Verify:

1. Oversized auth/share bodies -> `413`; ordinary content remains valid.
2. Repeated password/login attempts cross the threshold -> `429`; normal users are not cross-limited across unrelated routes.
3. Protected/admin responses are never shared-cacheable.
4. Headers are present and `x-powered-by` is absent.

Rollback: WAF rules and application headers/limits can be disabled independently.

Phase 1 production gate:

- [ ] Full tests and security regressions pass.
- [ ] Preview smoke covers public, protected, expired, admin edit/delete, and API creation.
- [ ] Vercel production deployment is `READY` and the same live routes are rechecked.
- [ ] No new 4xx/5xx spike appears during the observation window.

Estimated engineering effort: 3–5 focused days, excluding observation time.

## Phase 2 — Publishing UX and accessibility

### WP5: Restructure the creation flow

- [ ] Organize the page as Content -> Publish settings -> Publish result.
- [ ] Rename the main CTA to “发布并生成链接”.
- [ ] Represent idle, busy, success, and failure explicitly; use the CTA as the busy indicator.
- [ ] Add an explicit pre-publish preview action using the existing sandbox boundary; do not execute untrusted content in the parent origin.
- [ ] After success, show link, preview, access summary, password copy, and “继续创建”.
- [ ] Use `navigator.clipboard` with a safe fallback instead of repeated `execCommand` implementations.

### WP6: Accessibility and responsive admin

- [ ] Add real labels, `role="alert"`/`role="status"`, `aria-busy`, visible focus, and accessible icon names.
- [ ] Make password and result state changes readable by VoiceOver/NVDA.
- [ ] Fix admin navigation at 375 px with wrapping or a “更多” menu; keep horizontal scrolling inside table containers only.
- [ ] Add modal focus entry, trap, Escape handling, and focus restoration.
- [ ] Add table captions, `scope`, `aria-sort`, and text summaries for charts.
- [ ] Standardize the interface language on Chinese while keeping normal technical terms.

Verify:

1. 375 px -> no page-level horizontal scroll; all targets >= 44x44; 16 px inputs; all admin actions reachable.
2. 768 px -> stable single-column creation flow and usable filters/tables.
3. 1280/1440 px and 200% zoom -> no lost controls or layout overflow.
4. Keyboard-only -> login, publish, copy, protected unlock, and delete all complete.
5. VoiceOver -> publish status, errors, and protected unlock are announced.
6. Chrome and Safari -> light/dark visual smoke passes.

Rollback: creation UI and admin accessibility are separate commits; no data changes.

Estimated engineering effort: 2–4 focused days.

## Phase 3 — Database reliability, measurement, and measured performance

### WP7: Explicit migrations and connection-pool protection

- [ ] Add a small numbered SQL migration runner and `npm run db:migrate`; do not add an ORM.
- [ ] Move `pages`, `audit_logs`, `api_keys`, columns, and indexes out of request-time initialization.
- [ ] Make the baseline migration safe on both empty and existing databases.
- [ ] Add connection, idle, and statement/query timeouts plus `pool.on('error')`.
- [ ] Resolve the pg SSL warning explicitly and document use of the pooled database URL.
- [ ] Document first deploy, migration, verification, rollback, and recovery.

Verify:

1. Empty DB -> migrate -> smoke tests pass.
2. Existing schema -> migrate twice -> no data loss and no second-run changes.
3. First production request -> no DDL.
4. Unavailable DB -> failure occurs within the configured budget, below Vercel's 10-second function limit.

Rollback: migrations are additive; deploy schema first so the old application remains compatible.

### WP8: Establish `/view` performance baseline

- [ ] Add structured timing for request, DB, processing/render, response bytes, content type, protection state, and cold start.
- [ ] Log route templates, not full IDs or sensitive query strings; never log content, password, API key, or `_vercel_share` tokens.
- [ ] Record HTML/Markdown/SVG/Mermaid p50/p95 and content-size distribution for a representative traffic window.

Verify:

1. Every origin `/view/:id` request has complete timing fields.
2. Logs contain no sensitive values.
3. A baseline report can distinguish DB, render, cold-start, and large-response cost.

### WP9: Remove view-count writes from the HTML critical path

- [ ] Treat view count as approximate analytics and move it to a lightweight beacon/event request.
- [ ] Await persistence in the event request, not in the HTML response; beacon failure never blocks viewing.
- [ ] Do not add a queue/event table until measured traffic proves direct writes are a bottleneck.
- [ ] Keep public dynamic pages non-shared-cacheable initially so expiry/edit/revoke semantics remain exact.
- [ ] Consider short CDN caching only after an invalidation strategy is available, or after explicitly accepting a maximum stale window bounded by expiry.
- [ ] Add pre-rendered `rendered_html` only if WP8 shows render time is a material share of origin p95.

Verify:

1. HTML response completes without waiting for `view_count` update.
2. Analytics failure has no user-visible effect.
3. Expired/edited/deleted content never leaks from a stale shared cache.
4. Compare p95 and DB-write volume against WP8 baseline.

Rollback: remove beacon and restore the previous counter path; no schema required for the initial version.

### WP10: Route-specific assets, browser caching, and CSP readiness

- [ ] Stop loading Highlight.js and home scripts on login, password, error, stats, and audit pages.
- [ ] Stop loading homepage `main.js` on admin pages.
- [ ] Remove unnecessary third-party JavaScript from admin-origin pages; self-host the few assets still required.
- [ ] Split CSS/JS only by real route ownership; do not add Vite/Webpack solely for this change.
- [ ] Start static assets with a short browser cache; use one-year `immutable` only after content-hashed filenames exist.
- [ ] Add the missing root favicon mapping.
- [ ] Extract remaining inline parent-page scripts, then add a route-appropriate CSP without weakening the existing sandboxed viewer.

Verify:

1. Login has no Highlight.js or third-party JavaScript requests.
2. Admin pages do not request homepage scripts.
3. Static assets no longer return `max-age=0`, and a new deploy does not mix old/new HTML and CSS.
4. Browser console, upload, render, admin, light/dark, and mobile smoke tests pass.
5. CSP reports no required resource violations.

Estimated engineering effort: 3–5 focused days plus a representative 3–7 day measurement window.

## Phase 4 — Separate product milestone: stable versions and revocation

Start only after Phases 0–3 pass and the product gate is approved.

### WP11: Immutable revision history behind a stable share URL

- [ ] Add `page_revisions` with full immutable snapshots and additive `pages.updated_at`/`pages.revoked_at` fields.
- [ ] Insert revision 1 on create; update current page plus new revision in one transaction.
- [ ] Add revision list, diff, rollback, Raw, and download while preserving current `/view/:id` URLs.
- [ ] Public reads return `410` for revoked pages; admin retains hard delete.

### WP12: Agent/API lifecycle operations

- [ ] Keep `/api/v1/share` backward compatible.
- [ ] Add authenticated update, revision read/rollback, and revoke operations.
- [ ] Add managed API-key scopes for create/update/read/revoke before exposing broader external integrations.
- [ ] Add CLI/MCP only over the stable lifecycle API; do not create a second business-logic path.

Verify:

1. Concurrent updates create ordered, immutable revisions without lost updates.
2. Rollback creates a new revision rather than rewriting history.
3. Revocation takes effect immediately on public, password, raw, and metadata routes.
4. Scope-negative tests reject every unauthorized lifecycle action.
5. Existing create clients and old share URLs continue to work.

Estimated engineering effort: 5–8 focused days. This estimate excludes comments, collaboration, custom domains, client-side encryption, and team accounts.

## Explicit non-goals for this program

- [ ] No React/Vue/Next.js rewrite.
- [ ] No real-time collaborative editor or CodePen-style IDE.
- [ ] No public discovery feed, general file drive, or new content types/themes.
- [ ] No Redis/KV/runtime cache as source of truth.
- [ ] No exact billing-grade analytics, queue, materialized stats, cursor pagination, or `pg_trgm` until metrics trigger them.
- [ ] No broad `app.js` refactor during P0. Extract modules only when a work package needs a stable boundary and tests cover it.

## Final review section

Complete after implementation:

- Changed commits/PRs: WP0 `fccfb88`; WP1 `8801f22`; WP2 `b93b7e1`; WP3 `feat: publish shares with atomic access settings`.
- Test evidence: WP3 full suite `51/51` passed; `git diff --check` and JavaScript syntax checks passed.
- Preview evidence: local HTTP flow verified at 1440 px and 375 px; protected creation, wrong-password `401`, correct-password `200`, and unlocked content confirmed.
- Production deployment:
- Live route verification:
- Performance before/after:
- Rollback performed or available:
- Follow-up items intentionally deferred:
