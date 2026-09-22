# Publish operations: create idempotency and status confirmation

Scope: this document describes **what is implemented** — idempotent creation
(web page, dashboard clone, Share API), operation status confirmation, and the
deletion tombstone. Management write operations (content update, restore,
publish state) are **not** part of this protocol yet and no capability below
claims them.

## Request identity

- `Idempotency-Key` (Share API, web creation) / `requestId` form field
  (dashboard clone): 16–128 ASCII letters, digits, hyphens or underscores.
  Invalid values are a `400 INVALID_REQUEST_ID`. Clients generate UUID v4
  identifiers; the browser falls back to a well-formed RFC 4122 v4 generator
  when `crypto.randomUUID` is unavailable.
- One explicit intent carries one id. The same id with the same normalized
  input confirms the committed result; the same id with different input is
  `409 REQUEST_ID_CONFLICT` and commits nothing. The request HMAC covers
  normalized business values AND field presence (absent vs explicit-null are
  different literal requests); CSRF tokens, transport controls and identity
  secrets never enter the digest.
- Identical content with a NEW id is a NEW Share — content is never a dedupe
  key.
- Omitting the header on `POST /api/v1/share` keeps the legacy behavior
  (200, existing fields) which is **not** claimed to be deduplicated.

## Digest before randomness

The operation digest is an HMAC-SHA256 keyed by the application secret over
the normalized request descriptor (action, target, field presence and
normalized values, including a custom password's value but only its presence
for auto-generated ones). It is computed **before** any random Share id,
generated password, timestamp or time-derived fallback title exists, so a
retried operation hashes identically. The digest is keyed; request bodies and
passwords are never stored in the clear or stored at all.

The request digest never covers server-generated values. A committed request
whose `expiresAt` has since passed still replays as a success: the
future-expiry check runs only on the create path, never on a confirmed replay.

## Credential namespaces

Operation records are keyed `(actor_namespace, request_id)`. Namespaces are
separated by identity type and stable credential identity:

| Namespace | Principal | Stability |
| --- | --- | --- |
| `publish-session:<sid>` | browser creator via the independently signed `publish_session` cookie | stable across homepage access-mode changes; established on `GET /` **before** the first possibly-lost submit |
| `dashboard-session:<fp>` | owner dashboard clone (session fingerprint) | one login session |
| `managed-key:<logical id>` | managed API key | stable across secret rotation; the new secret confirms old operations |
| `legacy-key:<sha256>` | legacy `SHARE_API_KEY` | irreversible fingerprint of the secret; rotating the environment variable starts a fresh namespace |

The same request id in two namespaces is two legitimate operations; owners see
them listed separately in the dashboard. A rotated/revoked/deleted key cannot
authenticate at all, so it cannot replay anything. The request id itself is
never a credential.

## Transaction and lock order

Order inside one publishing transaction, one client:

1. maintenance gate (shared advisory lock, live setting read)
2. managed Key verification (`FOR UPDATE`, credential version re-check)
3. operation lock (`pg_advisory_xact_lock` over namespace + request id)
4. operation lookup (replay decision BEFORE expiry checks and clone source
   re-read)
5. Share rows (batch deletes use sorted ids), Revision, audit, grant-free
   creation writes
6. operation record insert (unique constraint is the final guard)

The response is constructed only after COMMIT. There is no running state: a
crash leaves either nothing or a fully committed result, never a task to
recover.

## Replays and receipts

- A replay confirms the ORIGINAL committed result: every response metadata
  field (isProtected, codeType, title, description, expiresAt, markdownTheme)
  comes from the encrypted receipt — the result exactly as committed. A
  create replay never reads the live Share row for metadata, so it can never
  become a channel for reading the owner's later edits; the live-row
  availability check only decides whether the result can be confirmed at all.
- Per #24 §8, replay re-checks the availability of the result Share AND its
  committed Revision. Tombstoned (deleted), Share-missing, or
  revision-missing results answer `410 RESULT_UNAVAILABLE` with no metadata
  and never rebuild anything.
- Receipts are stored for every creation and always encrypted with the
  existing application secret capability. The generated password (when one
  exists) is the sensitive member: it replays through the creator's own
  namespace only while the access policy is unchanged (access revision equal,
  Share still protected). Operation **status** endpoints return metadata
  only — no receipt, no body, no title/description/password ever passes
  through them.
- Deleting a Share clears its receipts and sets `deleted_at` in the same
  transaction, leaving a non-content dedupe tombstone. A late replay answers
  `410 RESULT_UNAVAILABLE` and never revives or recreates the Share.

## Owner review

The dashboard's Share list has a “按请求标识核对创建操作” panel backed by
`GET /admin/operations?requestId=…`. It lists every namespace's record for
that id with status and Share/version metadata. Owner review never returns
receipts; it cannot be used to replay secrets across identities.

## Backup and restore

`publish_operations` rows (including encrypted receipts and tombstones) are
part of the full backup inventory and are compared column-by-column by
`scripts/verify-backup.js` (`publishOperations` check). Restored snapshots
keep `safeToServe: false` and owner-review reconciliation semantics; see
[backup-restore](backup-restore.md).
