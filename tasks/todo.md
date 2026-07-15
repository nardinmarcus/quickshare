# QuickShare Optimization Implementation Plan

Status: Phases 0–3 deployed on 2026-07-15; the representative WP8 traffic baseline remains in passive collection.

Baseline reviewed: GitHub `main` commit `b3c15be67c93fc76e8ae047e82017f726d9cee12` and its current Vercel production deployment.

## Agreed operating rules

- [x] Keep PostgreSQL durable data as the source of truth. Browser, CDN, rendered output, and runtime caches are disposable derived layers only.
- [x] One work package per focused commit/PR; do not mix security, UI, performance, and product-schema refactors.
- [x] Add a failing regression test before each correctness/security fix.
- [x] Verify each package locally, in CI, on a preview deployment, and on production before continuing.
- [x] Preserve backward compatibility for existing share URLs and `/api/v1/share` unless explicitly approved otherwise.
- [x] Use additive/compatible database migrations; deploy schema before code that requires it.
- [x] Do not rewrite Express/EJS, introduce an ORM, add Redis/KV as truth, or split services.

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

- [x] Replace the global 15 MB parser with route-appropriate limits: small auth/form limits and the approved share-content limit.
- [x] Add edge rate limits for `/login`, `/admin/login`, `/view/:id/password`, `/api/pages/create`, and `/api/v1/share`; do not use an in-process Map as reliable limiter state.
- [x] Start with monitored conservative thresholds and tune from 429/error data.
- [x] Disable `x-powered-by`; add `X-Content-Type-Options` and `Referrer-Policy`.
- [x] Mark login, admin, password, and protected responses `private, no-store`.
- [x] Delay strict CSP until inline scripts and unnecessary third-party admin scripts are removed in Phase 3.

Verify:

1. Oversized auth/share bodies -> `413`; ordinary content remains valid.
2. Repeated password/login attempts cross the threshold -> `429`; normal users are not cross-limited across unrelated routes.
3. Protected/admin responses are never shared-cacheable.
4. Headers are present and `x-powered-by` is absent.

Rollback: WAF rules and application headers/limits can be disabled independently.

Phase 1 production gate:

- [x] Full tests and security regressions pass.
- [x] Preview smoke covers public, protected, expired, admin edit/delete, and API creation.
- [x] Vercel production deployment is `READY` and the same live routes are rechecked.
- [x] No new 4xx/5xx spike appears during the observation window.

Estimated engineering effort: 3–5 focused days, excluding observation time.

## Phase 2 — Publishing UX and accessibility

### WP5: Restructure the creation flow

- [x] Organize the page as Content -> Publish settings -> Publish result.
- [x] Rename the main CTA to “发布并生成链接”.
- [x] Represent idle, busy, success, and failure explicitly; use the CTA as the busy indicator.
- [x] Add an explicit pre-publish preview action using the existing sandbox boundary; do not execute untrusted content in the parent origin.
- [x] After success, show link, preview, access summary, password copy, and “继续创建”.
- [x] Use `navigator.clipboard` with a safe fallback instead of repeated `execCommand` implementations.

WP5 verification (2026-07-14):

- Full Node suite: `59/59` passed.
- Chromium desktop flow: Markdown preview, protected publish, result focus, link copy, and “继续创建” reset all passed.
- Race/fallback flow: clearing cancels an in-flight preview; edited drafts mark the receipt as previous; exact manual-copy text remains available when both clipboard paths fail.
- Chromium 375 px flow: no page-level horizontal overflow; primary action heights were `45.4 / 45.4 / 44 px`; sandbox preview rendered successfully.
- Browser console and page errors: none.

### WP6: Accessibility and responsive admin

- [x] Add real labels, `role="alert"`/`role="status"`, `aria-busy`, visible focus, and accessible icon names.
- [x] Make password and result state changes readable by VoiceOver/NVDA.
- [x] Fix admin navigation at 375 px with wrapping or a “更多” menu; keep horizontal scrolling inside table containers only.
- [x] Add modal focus entry, trap, Escape handling, and focus restoration.
- [x] Add table captions, `scope`, `aria-sort`, and text summaries for charts.
- [x] Standardize the interface language on Chinese while keeping normal technical terms.

Verify:

1. 375 px -> no page-level horizontal scroll; all targets >= 44x44; 16 px inputs; all admin actions reachable.
2. 768 px -> stable single-column creation flow and usable filters/tables.
3. 1280/1440 px and 200% zoom -> no lost controls or layout overflow.
4. Keyboard-only -> login, publish, copy, protected unlock, and delete all complete.
5. VoiceOver -> publish status, errors, and protected unlock are announced.
6. Chrome and Safari -> light/dark visual smoke passes.

WP6 verification (2026-07-14):

- Full Node suite: `70/70` passed.
- Chromium and WebKit: keyboard login, five-item admin navigation, single and batch delete dialog focus trap/Escape/restoration, detail-tab arrow/Home/End behavior, and light/dark smoke all passed.
- Mutation boundaries: an in-flight delete cannot be dismissed through cancel, backdrop, or Escape; hidden invalid passwords are discarded before saving; updated content invalidates and reloads the sandboxed preview.
- Protected flow: automatic password remained exactly six numeric digits; empty, wrong, and correct keyboard unlock paths produced distinct accessible states and the successful share rendered through the real sandboxed iframe.
- Chromium accessibility tree exposed the publish status, wrong-password alert, and named “确认删除” dialog.
- 375 px: document/body width remained exactly `375 px`; the `760 px` table stayed inside a `245 px` scroll container; measured navigation, checkbox, link, clone, and delete targets were all at least `44×44 px`.
- 640 px zoom proxy and 1440 px desktop: no page-level overflow; WebKit and Chromium reported no unexpected local resource, console, or page errors, including safe content rendering when Highlight.js CDN assets are unavailable.

Rollback: creation UI and admin accessibility are separate commits; no data changes.

Estimated engineering effort: 2–4 focused days.

## Phase 3 — Database reliability, measurement, and measured performance

### WP7: Explicit migrations and connection-pool protection

- [x] Add a small numbered SQL migration runner and `npm run db:migrate`; do not add an ORM.
- [x] Move `pages`, `audit_logs`, `api_keys`, columns, and indexes out of request-time initialization.
- [x] Make the baseline migration safe on both empty and existing databases.
- [x] Add connection, idle, and statement/query timeouts plus `pool.on('error')`.
- [x] Resolve the pg SSL warning explicitly and document use of the pooled database URL.
- [x] Document first deploy, migration, verification, rollback, and recovery.

Verify:

1. Empty DB -> migrate -> smoke tests pass.
2. Existing schema -> migrate twice -> no data loss and no second-run changes.
3. First production request -> no DDL.
4. Unavailable DB -> failure occurs within the configured budget, below Vercel's 10-second function limit.

Rollback: migrations are additive; deploy schema first so the old application remains compatible.

WP7 verification (2026-07-15): empty/legacy/idempotent/rollback and timeout integration checks passed against disposable PostgreSQL (`5/5` in the latest suite). Production migration applied once and then skipped on the second run; pre/post business row counts remained `174 / 136 / 1`.

### WP8: Establish `/view` performance baseline

- [x] Add structured timing for request, DB, processing/render, response bytes, content type, protection state, and cold start.
- [x] Log route templates, not full IDs or sensitive query strings; never log content, password, API key, or `_vercel_share` tokens.
- [ ] Record HTML/Markdown/SVG/Mermaid p50/p95 and content-size distribution for a representative traffic window.

Verify:

1. Every origin `/view/:id` request has complete timing fields.
2. Logs contain no sensitive values.
3. A baseline report can distinguish DB, render, cold-start, and large-response cost.

WP8 status (2026-07-15): instrumentation is live in production. The first 24-hour query contained only four synthetic `not_found` probes, so it is explicitly not a representative content-type baseline; continue passive collection before making render/cache decisions.

### WP9: Remove view-count writes from the HTML critical path

- [x] Treat view count as approximate analytics and move it to a lightweight beacon/event request.
- [x] Await persistence in the event request, not in the HTML response; beacon failure never blocks viewing.
- [x] Do not add a queue/event table until measured traffic proves direct writes are a bottleneck.
- [x] Keep public dynamic pages non-shared-cacheable initially so expiry/edit/revoke semantics remain exact.
- [x] Defer short CDN caching until an invalidation strategy exists or a bounded stale window is explicitly accepted.
- [x] Do not add `rendered_html` without a representative WP8 baseline showing render time materially affects origin p95.

Verify:

1. HTML response completes without waiting for `view_count` update.
2. Analytics failure has no user-visible effect.
3. Expired/edited/deleted content never leaks from a stale shared cache.
4. Compare p95 and DB-write volume against WP8 baseline.

Rollback: remove beacon and restore the previous counter path; no schema required for the initial version.

WP9 verification (2026-07-15): red/green route and repository tests cover same-origin, missing, expired, protected, authenticated admin preview, no-store, exactly-once browser reporting, and awaited persistence. Full Node suite passed `106/106`; disposable PostgreSQL passed `5/5`. Chromium verified both public and protected pages through the real `GET -> local reporter -> POST 204` path, including Origin and access cookie.

### WP10: Route-specific assets, browser caching, and CSP readiness

- [x] Stop loading Highlight.js and home scripts on login, password, error, stats, and audit pages.
- [x] Stop loading homepage `main.js` on admin pages.
- [x] Remove unnecessary third-party JavaScript from admin-origin pages; keep content-only CDN assets inside the sandbox boundary.
- [x] Split CSS/JS only by real route ownership; do not add Vite/Webpack solely for this change.
- [x] Start static assets with a short browser cache; use one-year `immutable` only after content-hashed filenames exist.
- [x] Add the missing root favicon mapping.
- [x] Extract remaining inline parent-page scripts, then add a route-appropriate CSP without weakening the existing sandboxed viewer.

Verify:

1. Login has no Highlight.js or third-party JavaScript requests.
2. Admin pages do not request homepage scripts.
3. Static assets no longer return `max-age=0`, and a new deploy does not mix old/new HTML and CSS.
4. Browser console, upload, render, admin, light/dark, and mobile smoke tests pass.
5. CSP reports no required resource violations.

WP10 verification (2026-07-15): trusted routes load only their owned scripts, static resources revalidate with a five-minute browser cache in both Express and Vercel edge configuration, and login/admin CSP is enforced without constraining shared `srcdoc` content. Node and Chromium smoke checks passed, including parent-frame isolation for executable shared HTML; exact deployed headers are checked before promotion.

Phase 3 production rollout (2026-07-15): deployment `dpl_BaG3esUoYGpf4ADem2q1nTtExteB` reached `READY` and was promoted to `quickshare.namooca.com`. Vercel inspection resolves the custom domain to that deployment. Live checks confirmed login `200` with private no-store/CSP, cached `view-event.js` with `max-age=300`, missing share/event `404`, two sanitized structured view events, and zero error-level rows in the initial window. The pre-WP9/WP10 production rollback candidate is `dpl_8mqsS4VEWmcjQEVxeuSnZwQwEdg6`.

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

- Changed commits/PRs: WP0 `fccfb88`; WP1 `8801f22`; WP2 `b93b7e1`; WP3 `feat: publish shares with atomic access settings`; WP4 `security: bound requests and harden responses`.
- Test evidence: WP3 full suite `51/51` passed; WP4 full suite `55/55` passed; `git diff --check` and JavaScript syntax checks passed.
- Preview evidence: isolated deployment `dpl_8zEScnraw5N9rEM6e4cS77G2yiBm` reached READY and passed public/protected/expired/admin/API smoke; 16 KB and 2 MB limits returned `413` above threshold.
- Production deployment: `dpl_4vJVEH4gxjtYWKQaCDD8ghmkGiPj` READY and aliased to `https://quickshare.namooca.com`; Firewall rule `QuickShare sensitive writes` enabled with no pending draft.
- Live route verification: existing public/protected pages returned `200`; protected responses were `private, no-store`; 16 KB excess returned `413`; Firewall threshold produced `20 x 401` then `2 x 429`; no deployment 5xx entries found in the immediate post-deploy window.
- Performance before/after: deferred to the measured WP8 baseline; Phase 1 made no unmeasured performance claim.
- Rollback performed or available: previous Vercel deployment remains promotable; application limits/headers and the Firewall rule can be rolled back independently.
- Follow-up items intentionally deferred: production 2 MB valid-key probe was not forced because Vercel returned the sensitive `SHARE_API_KEY` as blank; the same commit passed this boundary in isolated Preview and local regression.

# Homepage viewport layout optimization (2026-07-15)

- [x] Widen the desktop homepage container without changing login, password, or admin surfaces.
- [x] Use the additional width to keep the three publish metadata fields on one desktop row.
- [x] Reduce homepage-only top spacing and vertical gaps so the complete idle publishing flow fits at 1440x900 and 1280x800.
- [x] Preserve the existing single-column flow below 720px, with no page-level horizontal overflow at 375px.
- [x] Add a focused regression guard, run the full Node suite, and verify rendered screenshots at representative viewports.

Verify:

1. 1440x900 and 1280x800 -> editor, settings, access policy, actions, status, and footer are all visible without vertical scrolling.
2. 2048x1244 -> the card uses materially more horizontal space while remaining centered and readable.
3. 375x812 -> single-column form remains usable, controls stay at least 44px high, and document width stays exactly 375px.

Review:

- Root cause: the homepage inherited a 720px maximum width, used uncapped 8vh top padding, and placed three metadata fields across three rows at desktop widths.
- Desktop result: the card is 1080px wide; 1024x768, 1280x800, 1440x900, and 2048x1244 all render with document height equal to viewport height.
- Expanded states: generated-password settings, custom-password settings, and Markdown theme selection remain fully visible at 1440x900.
- Mobile result: 375px stays single-column with no horizontal overflow and 44px minimum action height; vertical scrolling remains intentional.
- Tests: focused regression failed before the CSS change and passed after it; full Node suite passed 107/107; browser console/page errors were empty in light and dark modes.

# Homepage upload entry hierarchy (2026-07-15)

- [x] Move the existing upload trigger from the final action row to the content-input header.
- [x] Give upload a visible accent treatment without competing spatially with the final publish CTA.
- [x] Preserve the existing file input and JavaScript upload behavior.
- [x] Keep the desktop idle flow within the tested viewport and mobile free of horizontal overflow.
- [x] Add a focused regression guard and verify file selection in a real browser.

Verify:

1. Upload is visible beside “分享内容” before the editor, while the bottom row contains only clear, preview, and publish actions.
2. Clicking upload opens the native file chooser and loading an accepted file populates the editor.
3. 1440x900 and 1024x768 remain one-screen layouts; 375px remains overflow-free with 44px controls.

Review:

- Placement: upload now sits beside “分享内容” and uses a solid primary treatment plus a compact “常用” badge; the final action row contains only clear, preview, and publish.
- Behavior: clicking the visible trigger opened Chrome's native file chooser; selecting `sample.md` populated the editor, displayed the filename, and changed the detected type to Markdown.
- Viewports: 1440x900 and 1024x768 both kept document height equal to viewport height; 375x812 stayed exactly 375px wide and retained a 44px upload target.
- Themes: light and dark screenshots kept the upload action legible and visually prominent.
- Tests: focused publishing UX tests passed 5/5, the full Node suite passed 107/107, and `git diff --check` passed.

# Homepage upload visual-weight correction (2026-07-15)

- [x] Replace the solid purple upload fill with a soft accent surface.
- [x] Keep upload discoverable through position, icon color, border, and the desktop badge.
- [x] Preserve the solid purple treatment exclusively for the final publish CTA.
- [x] Verify light, dark, and 375px rendered states without changing upload behavior.

Review:

- Visual weight: upload now uses a 7% primary tint, a 22% primary border, primary-colored icon, and normal foreground text; its shadow is removed.
- Hierarchy: the final publish action remains the only solid primary button on the page.
- Themes: light and dark screenshots retain readable text and a quiet but discoverable upload entry.
- Mobile: 375px remains exactly 375px wide, the upload target stays 44px high, and the compact view continues to hide the optional badge.
- Verification: focused publishing UX tests passed 5/5, the full Node suite passed 107/107, and `git diff --check` passed.

# Open generated safe preview in a new tab (2026-07-15)

- [x] Add a focused regression guard for a new-tab preview action and temporary URL cleanup.
- [x] Show the action only after a safe preview document has been generated.
- [x] Open the existing sandbox wrapper in a new tab without exposing raw user content to the QuickShare origin.
- [x] Invalidate the temporary preview when the draft changes, the preview closes, or a newer preview replaces it.
- [x] Verify the focused test, full Node suite, desktop browser flow, and 375px layout.

Verify:

1. Generate a safe preview -> “新标签打开” appears and opens the same rendered content in a separate tab.
2. Inspect the opened document -> submitted content remains inside an iframe without `allow-same-origin`.
3. Edit or close the preview -> the stale temporary URL is revoked and the action disappears.
4. 375px -> preview header actions remain usable without horizontal overflow.

Review:

- Behavior: a successful preview creates a temporary Blob URL from the exact server-rendered sandbox wrapper and reveals a semantic `target="_blank"` link; replacing, closing, editing, continuing, or publishing revokes and clears that URL.
- Security: a browser smoke test ran an inline script inside the nested preview while its attempted `window.top` access was blocked; the trusted page stayed unmodified, and the wrapper's inner iframe continues to omit `allow-same-origin`.
- Lifecycle: editing after preview hid the section, removed the outer `srcdoc`, removed the action `href`, and hid the action again.
- Responsive result: at 375px, document width remained 375px, both header controls were 44px high, and the 174px action group stayed within the 309px preview header.
- Verification: focused publishing UX tests passed 5/5, the full Node suite passed 107/107, JavaScript syntax and `git diff --check` passed, and the browser reported no console errors. The in-app browser policy did not permit automating the final Blob navigation, so that standard browser action is covered by the rendered `target`/`rel` contract plus live Blob-href generation rather than a scripted click.
