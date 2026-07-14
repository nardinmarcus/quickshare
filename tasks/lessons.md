# Lessons

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
