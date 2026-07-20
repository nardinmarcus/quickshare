# Lessons

## 2026-07-20 — Lock the transition state and whitelist degraded logs

- When a PostgreSQL mutation returns both previous and final state for auditing, lock the row that supplies those values before the conditional update; a single SQL statement without a lock can still report a stale transition under concurrency.
- Sanitized failure logging must whitelist every retained field. Do not copy `error.name`, `error.message`, or arbitrary `error.code` values merely because they are structured.

## 2026-07-20 — Match rendered assertions to the seeded domain record

- When an accessibility assertion includes a user-visible Share title, derive the expected wording from the test fixture rather than a nearby test label.
- Read the rendered failure output before changing production code; a title mismatch in the expectation is test-harness evidence, not a UI regression.

## 2026-07-14 — Preserve explicitly retained product behavior

- When a proposed security improvement changes visible behavior such as generated-password length or format, treat that as a product decision rather than silently strengthening it.
- If the user says to preserve existing behavior, lock it into the plan and regression tests before implementation.
- Keep generated-password behavior separate from custom-password policy: the former can remain stable while the latter uses an explicit shared allowlist.
- Define password validation once on the server and mirror it in homepage, admin, and API clients so validation rules cannot drift.

## 2026-07-14 — Verify the actual edge response, not only the rule label

- A Vercel Rate Limit rule can use different exceeded actions: default Rate Limit returns `429`, while Deny returns `403` even though the rule is still displayed as “Rate Limit”.
- Inspect the raw active configuration and exercise the real production threshold before marking edge protection complete.
- When the CLI summary hides a nested action change, use full JSON editing, review the staged diff, publish, and repeat the live verification.

## 2026-07-14 — Inventory every body-consuming route before removing a global parser

- Route-specific body limits must cover JSON and form submissions, including small HTML forms such as admin clone actions that carry CSRF tokens in the body.
- Search every `req.body` consumer and verify the real client `Content-Type`; a route that only reads middleware-owned fields can otherwise be easy to miss.
- Keep the full route suite in the verification gate because focused boundary tests cannot prove unrelated form actions still parse correctly.

## 2026-07-14 — A Ready Preview still needs a real function invocation

- Vercel can report a Preview as Ready even when the first function invocation fails during application startup.
- Check required environment-variable scope before debugging code; production-only authentication secrets can make a generic Preview fail safely.
- Do not relax production startup checks or copy production credentials broadly. Use a one-off SSO-protected Preview with temporary auth settings and explicitly blank database URLs when the goal is isolated runtime verification.

## 2026-07-14 — Keep shell interpolation out of database verification commands

- SQL placeholders such as `$1` inside a double-quoted shell command must be escaped or the shell will remove them before Node receives the query.
- Prefer a script file or an argument-safe invocation for multi-line verification logic; if an inline command is unavoidable, verify shell-sensitive characters before execution.
- A failed read-only syntax query is not evidence. Fix the invocation and repeat the same observable checks before recording results.

## 2026-07-14 — Treat previews as cancellable derived snapshots

- A non-persistent preview is still asynchronous state: publishing, clearing, continuing, or editing must abort or invalidate any older response.
- Mark a published receipt as the previous result as soon as the draft changes, so copy/open actions never imply that the current editor contents are already live.
- Keep the preview sandbox stricter than the published viewer when full form, popup, modal, and download behavior is not required for pre-publish inspection.

## 2026-07-14 — Make accessibility tests parse the artifact they claim to test

- Use HTML tag boundaries such as `<th\b`; a prefix-only expression also matches `<thead>` and creates a false failure.
- Static EJS contains `%>` inside attributes, so `[^>]*` is not a reliable stand-in for rendered HTML. Exercise the rendered route when attribute order matters, or bound static assertions to one source line.
- In browser tests, wait for the submitted navigation and asynchronous status text rather than assuming a keypress or a visible-but-empty live region has completed.
- Allow only the exact expected console error from a deliberate negative request, such as the tested unlock `401`; keep all other console and page errors failing.

## 2026-07-14 — Keep irreversible UI state aligned with the request lifecycle

- Once an irreversible mutation request is dispatched, disable every dismiss path and expose progress until the request succeeds or fails; otherwise the UI can imply cancellation while the server still commits the change.
- When a control hides a dependent field, clear its stale value and validation state, and gate both validation and payload construction on the controlling state.
- Invalidate derived previews after their source changes, reload through the real nested iframe consumer, and guard optional CDN globals so a third-party outage degrades without breaking content.

## 2026-07-15 — Revalidate imports after moving tests into nested suites

- Moving a test from `test/` to `test/integration/` changes every repository-relative import depth; update and syntax-check those imports before running an external integration dependency.
- A module-resolution failure means the database test never reached the database, so fix the harness and rerun the same assertions before recording migration evidence.

## 2026-07-15 — Keep worktree-only dependencies available until the final test run

- If a linked worktree uses an untracked `node_modules` symlink, remove it only immediately before staging or committing, then recreate it before starting the next test cycle.
- A dependency-resolution failure after removing that symlink is a harness failure, not a product regression; restore the same dependency tree and rerun the unchanged command.

## 2026-07-15 — Derive security mode from the loaded deployment environment

- Load environment files before deriving the runtime mode, and treat the platform production marker as authoritative alongside `NODE_ENV`; otherwise production-only validation can be bypassed by launch context.
- Validate structured credentials by the generator's decoded invariants, not a prefix-shaped regex, and use generator-compatible values in positive tests.

## 2026-07-15 — Keep production schema probes unambiguous and read-only

- Qualify shared catalog fields such as `table_name` when joining `information_schema` views; an ambiguous introspection query proves nothing about the schema it intended to verify.
- Run preflight and postflight snapshots inside explicit read-only transactions, and compare only metadata plus aggregate row counts so verification cannot expose content or mutate production.
- Check TLS from the client socket as well as database catalog views; a managed proxy can terminate TLS before the backend and make `pg_stat_ssl` alone misleading.

## 2026-07-15 — Keep analytics events lightweight and authenticate preview bypasses

- Moving a write out of the HTML response is not enough if the event endpoint reloads the full page body; use a conditional update and project only the state needed for rejected events.
- Treat preview or monitoring query parameters as user-controlled input. Any analytics bypass must also verify the corresponding authenticated session.
- Verify browser event paths through the real API boundary: confirm Origin, protected-page cookies, the local reporter asset, and the final `204`, not only mocked JavaScript calls.

## 2026-07-15 — Verify static headers at the platform edge

- Vercel can serve files from `public/` before a request reaches Express, so middleware cache headers are not proof of the deployed response.
- Mirror platform-served static policies in `vercel.json`, lock them with a config test, and inspect the exact canary deployment before promotion.

## 2026-07-15 — Treat multi-worktree merge exits as ambiguous

- `gh pr merge` can complete the remote merge and then exit non-zero when local branch cleanup tries to check out a base branch already owned by another worktree.
- In a multi-worktree repository, pass `--repo` to keep the operation remote-only. After any non-zero merge result, inspect the PR and remote main before retrying or changing branches.

## 2026-07-15 — Reserve solid brand color for one primary action

- A high-frequency helper action does not automatically deserve the same visual weight as the final CTA; two solid brand buttons create competing focal points.
- Prefer placement, icon color, a subtle tinted surface, and a quiet badge for discoverability when the final publish action must remain dominant.
- Judge hierarchy in the rendered page, including adjacent actions, instead of evaluating a button as an isolated component.

## 2026-07-15 — Do not make every visual group a box

- Count persistent outlines across the rendered screen before calling a UI polished; a card border plus an outline-style shadow is already a double frame.
- Establish raised, subtle, and divider surfaces first, then reserve visible boundaries for inputs, focus, selection, errors, tables, and sandboxed content.
- Review both the full page and compact mobile flow after removing borders, because a desktop surface can feel calmer while a stacked form still reads like an outlined checklist.

## 2026-07-15: Treat accent color feedback as a token-system correction

- When a user rejects the product accent, replace the primary, hover, focus, selection, and secondary accent tokens together so the old hue cannot survive in interaction states.
- A pale cyan fill needs a dark foreground, while a darker cyan fill can use white; encode that pairing explicitly instead of assuming every primary button should contain white text.
- Keep optional expressive themes isolated from the default shell, because changing the product default should not silently erase intentionally themed variants.

## 2026-07-15: Continue explicitly unfinished delivery after terse approval

- If a handoff names concrete unfinished steps such as commit and deploy, then `OK`, `move on`, or `开始干活` means continue those steps unless the user redirects the task.
- Do not turn a terse continuation into a conversational close and force the user to repeat the remaining work.
- State the inferred next action briefly, then execute through the same verification boundary already established for the repository.

## 2026-07-15: Keep each TDD tracer bullet behaviorally minimal

- Do not pre-implement a later behavior, even when its shape is obvious; first preserve a focused failing test for the current behavior.
- Add idempotency, rollback, and validation one failing assertion at a time so each green transition proves the intended production path.
- When an anticipated behavior slips in early, remove it, restore the red state, and then reintroduce it only after the corresponding test fails for the expected reason.

## 2026-07-15: Use the integration harness contract, not the runtime contract

- The disposable Postgres suite is intentionally gated by `POSTGRES_TEST_URL`; passing only `DATABASE_URL` means the harness must fail before touching a database.
- Reuse the exact integration command established by the test file, and distinguish an environment-contract failure from a product or migration failure.

## 2026-07-16: Exercise authenticated preview routes through their full browser boundary

- When a route requires a signed session, same-origin request, and CSRF token, build its regression test from the rendered page token instead of bypassing one layer of the contract.
- A `403` from an incomplete test request is harness evidence, not a product regression; correct the request and rerun the unchanged product assertion.
