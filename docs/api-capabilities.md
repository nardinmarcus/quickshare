# Share API identity, capabilities and OpenAPI

`GET /api/v1/me` and `GET /api/v1/capabilities` require `X-API-Key`. Dashboard, front-end login and access cookies never substitute for a Key. Missing, invalid or rotated credentials return 401; authentication storage failures return 503. Responses are private/no-store. Discovery remains available during publishing maintenance.

`/me` returns the canonical instance `origin`, `credentialKind` (`legacy` or `managed`) and the scopes this credential may request. Managed identities additionally expose `id`, `name` and decimal-string `credentialVersion`. Secrets, hashes, grants and unrelated resources are never returned. Legacy environment Keys always remain create-only.

`/capabilities` returns `success`, `protocolVersion`, `contentTypes`, `markdownThemePresets`, configured parser `limits`, `operations`, implemented/not-implemented `scopes` and the idempotency contract. The executable capability source is [`utils/apiCapabilities.js`](../utils/apiCapabilities.js); parser limits, request discovery, the dashboard reference and [`docs/openapi.yaml`](openapi.yaml) are synchronized from these definitions. The OpenAPI document is a **bounded subset** of public `/api/v1` operations, not a complete schema for every QuickShare route. It intentionally excludes dashboard routes, legacy `/api/pages`, public view routes, private client-maintenance actions and history purge.

## Authorization vocabulary

Managed-Key scopes and per-Share grants are separate gates:

| Scope | Matching resource grant | Capability |
| --- | --- | --- |
| `share:create` | none | Create a new Share; optional creation replay/status remains namespace-bound |
| `share:read` | `can_read` | List granted Shares, read current content and history, and read minimal state |
| `share:update` | together with `share:read` | Conditional content update and restore; per-Share `can_update` also implies `can_read` |
| `share:publish` | `can_publish` | Read minimal state and conditionally unpublish/republish; never implies reading |

New managed Keys start with only `share:create`. The owner explicitly grants read, edit and publish separately in `/admin/apis`; edit implies read, but publish never does. First/last resource grants add/remove the corresponding scope. Auto-grant-for-future-created-Shares adds read+edit only; it never adds publish. Rotation preserves grants and scopes while invalidating the old secret. Legacy Keys remain create-only.

Missing/invalid credentials return 401. An authenticated credential without the needed scope returns 403. A present scope without its matching target grant returns a 404 indistinguishable from a missing Share. Management authorization is separate from public visibility: an authorized readable Share can be unpublished, protected or expired and still be read through the read APIs. All Key management responses are private/no-store and omit password material, grants, Favorite state and view counts.

## Exposed resource operations

- `GET /api/v1/shares`: stable `(created_at, id)` cursor; default 20, maximum 100. Only `can_read` Shares appear. Metadata projection contains title/description, but no body or password fields. Publish-only Shares never enter this list.
- `GET /api/v1/shares/:id/content`: current full content snapshot under `share:read` + `can_read`; returns a strong ETag `"content:<id>:<decimalRevision>"`. Matching `If-None-Match` returns 304.
- `GET /api/v1/shares/:id/revisions` and `/revisions/:revision`: `share:read` + `can_read`; history listing is metadata-only and one-revision reads return one canonical snapshot. Purged content is 410 without payload.
- `GET /api/v1/shares/:id/state`: minimal allow-list `id`, `published`, `isProtected`, `expiresAt`, `accessRevision` under either **`share:read` + `can_read`** or **`share:publish` + `can_publish`**. It returns the strong, independent state ETag `"access:<id>:<decimalAccessRevision>"`. Publish-only grants cannot read list, content, revision history, title/description metadata or API content-update responses.

List, current-content and minimal-state GETs return retryable storage failures as private/no-store `503 API_READ_UNAVAILABLE` with `requestId: null` and `retryable: true`; the message never includes database diagnostics. Missing/invalid credentials, missing scopes/grants and malformed query inputs retain their distinct 401/403/404/400 contracts.
- `PUT /api/v1/shares/:id/content`: requires a managed Key with `share:read` + `share:update`, `can_read` + `can_update`, a concrete strong content `If-Match` and `Idempotency-Key`. The body is a strict full snapshot with `htmlContent`, `title`, `description`, `markdownTheme`, and optional unchanged `codeType`.
- `POST /api/v1/shares/:id/restore`: requires the same read+edit capability, current content `If-Match`, and `Idempotency-Key`; body contains only `{ "revision": <positive integer or canonical decimal string> }`.
- `POST /api/v1/shares/:id/unpublish` and `/republish`: require managed `share:publish` + `can_publish`, a concrete strong **access** `If-Match` from the state endpoint, `Idempotency-Key`, and an empty JSON object body `{}`. `smallRequestBodyBytes` (default 16 KiB) is enforced. Content ETags, weak/wildcard/list validators and all content/policy fields are rejected. A transition changes only `published` and `accessRevision`, atomically with its audit and operation result. It does not alter content revisions, password/protection, expiry or URL; a real transition invalidates old access cookies. Same-state no-op does not bump the version or duplicate the audit.
- `GET /api/v1/operations/:requestId`: current credential namespace only; metadata-only. For update/restore/publish records it additionally rechecks the matching current scope and Share grant. Revoked or rotated credentials cannot replay a write or inspect its result. A publish result is not projected as current state if `accessRevision` has changed since the operation committed.

Publish lifecycle still follows the owner/public projection from #35: unpublished/missing/deleted Shares are neutral 404; a published expired Share is 410; republishing does not unprotect it or extend its expiry. Offline backup, purge and public-visibility rules are not altered by these Key operations.

## Conditional writes, idempotency and limits

`Idempotency-Key` is 16–128 ASCII letters, digits, hyphens or underscores. A retry of one explicit intent reuses the same key and exact input; a different digest on the same key is 409. Content writes use only a content ETag; publication-state writes use only an access ETag. Missing required headers are 428, malformed/weak/wildcard/list/wrong-family validators are 400, and a stale strong validator is 412. Lock contention, database outage or publishing maintenance returns retryable 503. Replay is considered only after revalidating the current credential version, applicable scope and resource grant. If authorization was revoked, the old result is not returned. If the access state changed after a publish result, a matching retry may confirm completion but does not return the stale published value or ETag.

`shareRequestBodyBytes` and `smallRequestBodyBytes` report the configured decoded JSON parser limits (defaults 2 MiB and 16 KiB). They count JSON structure, metadata and escape sequences; they are not a separate raw-content allowance. A larger transport/proxy limit may still be lower. Exceeding the parser limit returns 413.

## Backups and boundaries

The existing native backup verifier compares the full `share_grants` row, including `can_publish`, Key scopes, and every publish-operation field. Restores remain offline by default (`safeToServe: false`); #39 does not create a Key/history purge route or change the verifier's reconciliation requirements. See [`docs/publishing-operations.md`](publishing-operations.md), [`docs/backup-restore.md`](backup-restore.md), and [`docs/openapi.yaml`](openapi.yaml).
