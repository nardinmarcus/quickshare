# Lessons

## 2026-07-14 — Preserve explicitly retained product behavior

- When a proposed security improvement changes visible behavior such as generated-password length or format, treat that as a product decision rather than silently strengthening it.
- If the user says to preserve existing behavior, lock it into the plan and regression tests before implementation.
- Keep generated-password behavior separate from custom-password policy: the former can remain stable while the latter uses an explicit shared allowlist.
- Define password validation once on the server and mirror it in homepage, admin, and API clients so validation rules cannot drift.
