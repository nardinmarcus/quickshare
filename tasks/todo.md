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

# Homepage expiry date picker (2026-07-15)

- [x] Replace the homepage manual date-time field with a native date picker.
- [x] Treat the selected local date as expiring at the end of that day and keep server timestamps unchanged.
- [x] Expose the date-picker semantics and expiry rule accessibly in the form.
- [x] Add a focused regression guard and run the relevant/full test suites.
- [x] Verify selection, validation, and responsive light/dark rendering in a real browser.

Verify:

1. Open the homepage -> the expiry field exposes a calendar date picker rather than a date-time text workflow.
2. Select today or a future date -> the publish payload contains the selected local day at `23:59:59.999`.
3. Clear the selection -> publishing remains allowed with no expiry.
4. Light, dark, and 375px layouts -> the calendar affordance stays visible and the form remains overflow-free.

Review:

- Form behavior: the homepage now renders a native `date` input with an accessible hint and a visible calendar affordance in both light and dark themes.
- Expiry semantics: `2026-07-16` produced `1784217599999`, exactly the browser-local `2026-07-16 23:59:59.999`; the server continues receiving the existing millisecond timestamp contract.
- Validation: the picker minimum tracks the browser's current local date, past or malformed values retain client/server rejection, and an empty value still publishes without expiry.
- Responsive result: the 375px browser viewport kept `scrollWidth === innerWidth === 375`; the date control and explanatory hint remained fully usable.
- Verification: focused regression passed 1/1, the full Node suite passed 108/108, JavaScript syntax and `git diff --check` passed, and browser console/page errors were empty.

# Quiet workbench UI polish (2026-07-15)

- [x] Add explicit raised, subtle, divider, and control surface tokens for the default light/dark shell.
- [x] Remove decorative card outlines, glow, and motion while retaining semantic input, focus, error, selected, and iframe boundaries.
- [x] Turn homepage access choices and secondary actions into tonal controls with one solid publish CTA.
- [x] Group admin metrics and navigation into calmer shared surfaces while retaining table row separators.
- [x] Modernize login/password surfaces without changing authentication behavior or accessibility contracts.
- [x] Update the active visual direction in `DESIGN.md` and capture the correction in `tasks/lessons.md`.
- [x] Run the full test suite, JavaScript syntax checks, `git diff --check`, and desktop/375px light-dark browser screenshots.

Visual direction:

- Visual thesis: quiet tonal workbench, neutral system surfaces, and one restrained cyan action.
- Content plan: preserve the existing utility flow and semantic HTML; change visual hierarchy only.
- Interaction thesis: short background and opacity transitions, no ambient glow, no card lift, and clear focus rings.

Verify:

1. `/` at 1440px and 375px -> fewer nested outlines, one dominant CTA, no overflow, and all controls remain at least 44px.
2. `/admin/stats` and `/admin/pages` -> navigation and metrics read as grouped surfaces; table rows remain scannable.
3. `/login` and protected password entry -> no glow animation, focus remains obvious, and keyboard behavior is unchanged.
4. Light and dark modes -> adjacent surfaces remain distinguishable without relying on card borders.

Review:

- Root cause: cards used both a solid border and an outline-style shadow, while missing secondary surface tokens left nested groups transparent and border-dependent.
- Homepage: visible outlined elements dropped from 12 to 1 in the light rendered audit; fields, access choices, upload, and secondary actions now use tonal surfaces while publish remains the only solid primary action.
- Admin: statistics changed from 28 individually bordered elements to grouped metric and chart surfaces; the 375px empty-state page shortened from 1962px to 1561px without changing content.
- Responsive: homepage light and dark renders both kept `innerWidth === scrollWidth === 375`; the smallest visible action target remained 44px.
- Authentication: login and protected-content cards render without borders or glow; the focused password input keeps a 3px focus ring.
- Verification: full Node suite passed 108/108, all public JavaScript files passed `node --check`, `git diff --check` passed, and browser checks reported no page or console errors.
- Known unchanged behavior: the 14-day admin timeline remains an intentionally contained horizontal scroller on narrow screens.

# Cyan accent correction (2026-07-15)

- [x] Replace the default light/dark purple tokens with an accessible cyan palette.
- [x] Keep named theme palettes isolated and update the active direction in `DESIGN.md`.
- [x] Verify contrast, desktop/375px rendering, tests, and source checks.

Review:

- Palette: dark mode uses `#5eead4` with `#083344`; light mode uses `#0f766e` with white. Secondary accent states use the neighboring cyan family.
- Rendered proof: the homepage and statistics page had zero computed hits for the previous purple tokens in light and dark modes.
- Contrast: the primary CTA measured 9.06:1 in dark mode and 5.47:1 in light mode.
- Responsive: desktop and 375px homepage renders kept `scrollWidth === innerWidth`; browser console and request failures were empty.
- Verification: all 108 Node tests passed, every `public/js/*.js` file passed `node --check`, and `git diff --check` passed.
- Environment note: local production startup correctly rejected missing production password hashes, so visual smoke testing used development mode with authentication explicitly disabled.

# Quiet workbench production release (2026-07-15)

- [x] Audit the complete UI diff and confirm the release contains no unrelated changes.
- [x] Commit the coherent UI release on `main` and push it to `origin/main`.
- [x] Deploy the committed revision to the linked Vercel production project.
- [x] Inspect the deployment and verify production routes, cyan assets, desktop rendering, and 375px rendering.

Verify:

1. Git release -> `origin/main` resolves to the new UI commit and the local worktree is clean.
2. Vercel deployment -> status is `READY` and the production alias points at the committed deployment.
3. `https://quickshare.namooca.com/` -> the served stylesheet contains the quiet workbench and cyan tokens.
4. Live browser -> homepage and admin surfaces render without old purple tokens, console errors, or page-level mobile overflow.

Review:

- Scope: the release contains only the UI stylesheet, active visual specification, task record, and correction lessons.
- Local gate: all 108 tests, JavaScript syntax checks, `git diff --check`, light/dark screenshots, and 375px overflow checks passed before release.
- Production gate: require the committed revision on `origin/main`, a Vercel `READY` deployment, exact stylesheet assertions, and live desktop/mobile browser proof before handoff.

# Homepage password toggle implementation (2026-07-15)

Status: complete; production is live in public mode.

Specification: `docs/superpowers/specs/2026-07-15-homepage-password-toggle-design.md`

Confirmed TDD seams:

- Migration and Repository public methods.
- HTTP behavior at homepage, browser publish, preview, admin settings, and unchanged protected routes.
- Admin stats UI behavior through rendered HTML and a real browser.
- Preview and production deployment routes plus persisted Postgres state.

## Slice 1 — Persisted setting and transactional audit

- [x] Add failing migration/Repository behavior tests for the singleton default, idempotent update, and audit record.
- [x] Add additive migration `002_site_settings.sql` with a fail-closed default of `true`.
- [x] Add matching Postgres and Memory Repository setting methods.
- [x] Verify focused tests, migration idempotency, and rollback behavior.

Verify:

1. Empty and legacy databases migrate -> `site_settings.id=1` exists with `homepage_password_required=true`.
2. Update to public and back -> Repository reads the persisted value and records each real transition once.
3. Submit the current value -> `changed=false` and no audit row is added.
4. Force the audit insert to fail -> the setting change is rolled back.

## Slice 2 — Dynamic homepage and browser-publish access

- [x] Add failing HTTP tests for locked, public, same-origin, cross-origin, relocked, and retained-session behavior.
- [x] Add narrowly scoped dynamic access middleware for `/`, create, and preview only.
- [x] Keep recent-list, protection mutation, dashboard, Share API, and per-share password boundaries unchanged.
- [x] Make homepage responses `private, no-store` and fail closed with `503` when the setting is unavailable.

Verify:

1. Default locked mode -> anonymous homepage redirects and browser create/preview return `401`.
2. Public mode -> anonymous homepage returns `200`; same-origin create/preview work.
3. Missing or cross-origin `Origin` -> public create/preview return `403`.
4. Relock -> new anonymous access is blocked while an existing valid `admin_session` still works.
5. Protected adjacent routes -> existing authentication results do not change.

## Slice 3 — Admin toggle and accessible interaction

- [x] Add failing admin route tests for settings render, authentication, CSRF, validation, update, idempotency, and audit.
- [x] Add the authenticated JSON settings endpoint with explicit `400/401/403/503` responses.
- [x] Add the `/admin/stats` access-control card, confirmation dialog, live status, and dedicated local script.
- [x] Keep controls disabled through the request lifecycle and restore the persisted state after failure.
- [x] Add focused accessibility/resource-policy coverage for the new UI and script ownership.

Verify:

1. Dashboard login -> stats shows the persisted state and a dashboard CSRF token.
2. Switch to public -> confirmation appears; cancel does not write; confirm changes state and audit atomically.
3. Switch to locked -> request submits immediately and new anonymous requests are blocked.
4. Expired session, bad CSRF, invalid payload, and database failure -> UI and API expose the specified safe state.

## Slice 4 — Full verification and release

- [x] Update deployment and security-boundary documentation.
- [x] Run focused tests, full `npm test`, JavaScript syntax checks, and `git diff --check`.
- [x] Run `npm run test:postgres` against a disposable local `_test` database.
- [x] Verify toggle, confirmation, public publish, relock, retained session, mobile layout, and console state in a real browser.
- [x] Commit and push the implementation only after all local gates pass.
- [x] Apply migration to production, repeat it to prove idempotency, then deploy the committed revision.
- [x] Verify live routes, persisted setting, audit log, Vercel Firewall, and rollback path.

Verify:

1. Before toggle -> production remains password-required after schema and code deploy.
2. Admin toggle off -> anonymous homepage and same-origin browser publishing work live.
3. Admin toggle on -> anonymous homepage immediately redirects while existing session remains valid.
4. `/admin`, `/api/v1/share`, legacy management routes, and protected shares preserve their authentication contracts.
5. Deployment inspection -> committed revision is `READY`, aliased to `quickshare.namooca.com`, and emits no new error-level logs.

## Review

- Changed files/commits: design `9c42a94`; implementation `b42bda7`. The implementation spans the additive migration, Repository methods, route middleware, admin UI/script, docs, and focused tests.
- Test evidence: 132/132 Node tests and 8/8 disposable-Postgres integration tests passed; JavaScript syntax and diff checks passed.
- Browser evidence: locked/cancel/public preview/public publish/relock/retained-session flows passed in Chromium; 375px layout had no page overflow, focus returned correctly after Esc, and console/page errors were empty.
- Migration evidence: production preflight contained migration `001` and 181 pages; the first migration run applied only `002_site_settings.sql`, the second applied zero and skipped both versions. Postflight preserved the original table counts and created singleton `id=1` in locked mode over an encrypted client connection.
- Production deployment and rollback evidence: Vercel deployment `dpl_EHWtTQZTbCQ4DmMcYJz7LHULxtKp` reached `READY` and was aliased to `quickshare.namooca.com`. The authenticated admin UI switched public, a clean anonymous browser previewed and published share `SK8pjKzfUtOR`, missing/cross-origin requests returned `403`, and admin/recent/Share API boundaries stayed locked. A live relock redirected a clean session while retaining an existing homepage session, then the admin UI restored public mode. Database readback ended at `homepage_password_required=false` with exactly three ordered setting-transition audits; Vercel error/fatal/5xx scans were empty and the enabled 20-per-60-second sensitive-write firewall rule had no draft changes.

## Umami analytics integration

- [x] Load the provided Umami tracker once on EJS-rendered site pages.
- [x] Track real `/view/:id` pages without injecting analytics into preview documents or shared `srcdoc` content.
- [x] Allow the Umami script and event endpoint through the trusted-page CSP.
- [x] Verify the tracker markup, preview exclusion, CSP, and full test suite.

Review (2026-07-16): the supplied tracker is present once on shared EJS pages and real share wrappers, while generated previews remain untracked. Trusted-page CSP permits only the exact Umami origin for scripts and event delivery. `node --test test/resource-policy.test.js` passed `6/6`, the full `npm test` suite passed `133/133`, `git diff --check` passed, and `https://umami.namooca.com/script.js` returned HTTP `200` with a JavaScript content type.

# Admin favorite feature design session (2026-07-20)

Status: specification published as GitHub Issue #5 with `ready-for-agent`; feature implementation has not started.

- [x] Inspect the current admin authentication boundary, page-list filters, Repository implementations, migrations, and route tests.
- [x] Resolve whether a favorite is shared dashboard metadata or personal administrator state: it is global metadata on a Share and is identical across dashboard sessions.
- [x] Resolve favorite lifecycle behavior, list interaction, filtering, cloning, export, and audit expectations one decision at a time.
  - [x] Model favorite as a binary marked/unmarked classification without a favorite timestamp or favorite-specific ordering.
  - [x] Keep the favorite filter to `all` and `favorites only`; combine it with the existing search, type, protection-status, and date filters.
  - [x] Expose the favorite toggle in each admin-list row and in the admin-detail header; never expose it on a public Share.
  - [x] A cloned Share starts unmarked even when its source is a Favorite Share; the source remains unchanged.
  - [x] Include favorite state as `isFavorite` in the admin JSON export.
  - [x] Record each real favorite-state transition as `page.favorite.update` with `from` and `to`; do not audit idempotent submissions.
  - [x] Keep favorite status independent of expiration; expired Shares remain markable and filterable, while deleting a Share removes its favorite status with the entity.
  - [x] In favorites-only results, wait for server success before refreshing the filtered list so an unmarked row disappears and totals/pagination remain correct.
  - [x] Keep bulk favorite and bulk unfavorite actions out of scope for the first version.
  - [x] Render an unmarked Share with a neutral outline star and a Favorite Share with a filled cyan star, plus text and `aria-pressed` semantics.
  - [x] Keep a successful favorite-state change when its best-effort audit write fails; log the audit failure on the server.
- [x] Record agreed domain terms in `CONTEXT.md`; no ADR is needed because the decisions are compatible, unsurprising, and reversible.
- [x] Produce a minimal implementation plan with explicit migration, application, UI, test, deployment, and rollback checks: `docs/superpowers/specs/2026-07-20-admin-favorites-design.md`.
- [x] Publish the agreed specification as [GitHub Issue #5](https://github.com/nardinmarcus/quickshare/issues/5) with `ready-for-agent`; keep feature code unchanged in this task.

Verify:

1. Repository facts -> every claimed constraint is traceable to the current checkout rather than runtime cache or historical notes.
2. Product decisions -> each unresolved branch has an explicit user answer and recommended default.
3. Documentation -> the glossary contains domain language only; implementation details remain in this task plan.
4. Implementation gate -> no migration, route, Repository, template, script, or test file changes before explicit approval.

## Ticket publication review

- [x] Split parent Issue #5 into four approved tracer-bullet Tickets sized for one fresh implementation context each.
- [x] Publish Issues #6–#9 with the `ready-for-agent` label and explicit parent and blocker references.
- [x] Add GitHub-native blocking relationships: #7 and #8 are blocked by #6; #9 is blocked by #7 and #8.
- [x] Read back every child Issue and confirm the parent Issue remains open and unmodified.

Frontier:

- [Issue #6](https://github.com/nardinmarcus/quickshare/issues/6) can start immediately.
- [Issue #7](https://github.com/nardinmarcus/quickshare/issues/7) and [Issue #8](https://github.com/nardinmarcus/quickshare/issues/8) become available after #6.
- [Issue #9](https://github.com/nardinmarcus/quickshare/issues/9) becomes available after both #7 and #8.

No Favorite Share implementation code was changed while publishing the Tickets.

# Issue #6 — Favorite Share detail end-to-end (2026-07-20)

Status: implementation, review remediation, and local verification complete. Scope is limited to GitHub Issue #6.

## Confirmed TDD seams

- Repository contract: `MemoryPageRepository` and `PostgresPageRepository` expose identical default, lookup, mark, unmark, idempotent-repeat, and missing-Share behavior.
- Authenticated HTTP boundary: `PUT /admin/pages/:id/favorite` proves Dashboard authentication, CSRF, strict boolean validation, response status/shape, idempotency, audit, and audit-failure degradation.
- Rendered detail/browser boundary: the admin detail page renders the persisted state and one shared favorite controller changes it only after a successful server response.

## Plan

- [x] Add a failing migration/repository behavior slice, then implement additive `003_page_favorites.sql` and matching Memory/PostgreSQL `setFavorite` contracts.
- [x] Add a failing authenticated route slice, then implement the strict idempotent endpoint and best-effort `page.favorite.update` audit.
- [x] Add a failing rendered/interaction slice, then implement the detail-page outline/filled star, visible text, accessible state, busy state, and failure feedback.
- [x] Run focused test files after each slice and JavaScript syntax checks regularly.
- [x] Run the full test suite, PostgreSQL integration suite when its configured seam is available, `git diff --check`, and the required two-axis code review.
- [x] Fix review findings, document evidence below, and commit the focused work to the current branch.

Verify:

1. Migration and storage -> both repositories report the same final/previous values; rerunning migration never resets a changed favorite.
2. HTTP and audit -> invalid boundaries never write; real transitions audit exactly once; idempotent requests do not audit; audit failure does not undo the favorite.
3. Detail UI -> server-rendered state, explicit accessible name, `aria-pressed`, 44px target, server-confirmed update, and non-optimistic failure behavior are observable.
4. Scope -> public Share and existing Share API behavior remain unchanged; every retained diff line maps to Issue #6.

## Review

Local evidence: focused Issue #6 checks passed `47/47`; after review remediation, the complete `npm test` suite passed `146/146`; changed JavaScript syntax checks and `git diff --check` passed. The real PostgreSQL test seam is implemented but was not executed because `POSTGRES_TEST_URL` is not configured in this thread.

- Standards review: resolved all three findings by preserving the existing admin-list Repository contract, using `Share` in user-visible error copy, and binding only the detail page's single favorite control. The required audit identifier remains `page.favorite.update` because Issue #6 specifies it exactly.
- Spec review: resolved both findings by locking the PostgreSQL transition row before deriving `from`/`to`, and by logging only the existing allowlisted safe error code during audit degradation.

# Issue #8 — Favorite Share lifecycle and data boundaries (2026-07-20)

Status: implementation, review remediation, and local verification complete on isolated branch `codex/issue-8-favorite-lifecycle`; baseline is Issue #6 commit `f2d768c`.

## Confirmed TDD seams

- Administrative HTTP boundary: creation, clone, edit, expiration, favorite mutation, deletion, and unfiltered JSON export are observed through authenticated routes and persisted Repository results.
- Public HTTP boundary: public view, password validation, metadata, recent list, view event, statistics, and both existing creation APIs never accept or expose Favorite Share state.
- Repository projection boundary: public lookup omits administrative favorite metadata, while administrative list projection supplies the boolean needed by export.

## Plan

- [x] Add a failing management-export slice, then expose `is_favorite` only through the administrative projection and export it as boolean `isFavorite` without inheriting request filters.
- [x] Add a failing public-projection slice, then keep `is_favorite` out of the Repository object returned by public lookup.
- [x] Add lifecycle regression coverage proving homepage/API creation defaults, clone reset, edit preservation, expiration independence and operability, and deletion cleanup.
- [x] Add public-boundary coverage for view, password, metadata, recent list, view event, statistics, and Share API request/response compatibility.
- [x] Run focused tests after each slice, then the complete Node suite, available PostgreSQL integration seam, JavaScript syntax checks, and `git diff --check`.
- [x] Run the required Standards and Spec reviews against `f2d768c`, remediate findings, record evidence below, and commit the focused branch.

Verify:

1. Creation and clone -> homepage, Share API, and Favorite Share clone all persist `is_favorite=false`, even when input or source state is true.
2. Edit and expiration -> content/access/expiry changes preserve favorite state; expired Shares remain available to admin favorite mutation and administrative projection.
3. Deletion and export -> deleting the Share removes the only favorite record; export includes a boolean for every Share and ignores list-style query filters.
4. Public boundaries -> no public or existing Share API request/response gains Favorite Share behavior or metadata; view, password, expiry, URL, and view-count behavior remain unchanged.
5. Scope -> no list filtering/UI work from Issue #7 is duplicated; every retained diff line maps to Issue #8.

## Review

Local evidence: focused lifecycle and Repository checks passed `20/20`; the complete `npm test` suite passed `156/156`; changed JavaScript syntax checks and `git diff --check` passed. The real PostgreSQL lifecycle test is implemented but was not executed because `POSTGRES_TEST_URL` is not configured and no local PostgreSQL client/service is available in this thread.

- Initial Standards review found no issues. Initial Spec review found that export silently stopped at 10,000 Shares and that the production PostgreSQL lifecycle lacked integration coverage.
- Remediation replaced the fixed export ceiling with an explicit unpaginated Repository read for both storage implementations, added a 10,001-Share HTTP regression, locked default PostgreSQL pagination with a unit test, and added a real PostgreSQL lifecycle/inventory integration scenario.
- Final Standards and Spec reviews found no remaining actionable issues and confirmed no Issue #7 list-filtering or list-UI scope was introduced.
