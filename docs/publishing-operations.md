# Publish operations: create, dashboard save/restore idempotency and status confirmation

Scope: this document describes **what is implemented** — idempotent creation
(web page, dashboard clone, Share API), idempotent dashboard content updates
and history restores (#33), operation status confirmation, and the deletion
tombstone. Key-driven management writes (content update, restore, publish
state over `X-API-Key`) are **not** part of this protocol yet and no
capability below claims them.

## Request identity

- `Idempotency-Key` (Share API, web creation, dashboard content save and
  restore) / `requestId` form field (dashboard clone): 16–128 ASCII letters,
  digits, hyphens or underscores. Invalid values are a
  `400 INVALID_REQUEST_ID`. Clients generate UUID v4 identifiers; the browser
  falls back to a well-formed RFC 4122 v4 generator when
  `crypto.randomUUID` is unavailable.
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

## Dashboard content saves and restores (#33)

The owner dashboard reuses the same ledger with two targeted actions:

- **`content-update`** (`PUT /admin/pages/:id` with an `Idempotency-Key`):
  the digest covers the EXPECTED content revision (the `If-Match` baseline),
  the normalized title/description and the exact candidate body bytes, plus
  field presence (including optional `codeType`). The Markdown theme enters as the submitted literal — the
  client re-sends identical bytes on retry, and theme resolution depends on
  the share's immutable code type inside the transaction. Policy-only and
  combined saves reject the header with `400 UNSUPPORTED_REQUEST_ID_SCOPE`
  instead of partially replaying.
- **`restore`** (`POST /admin/pages/:id/restore`, required `Idempotency-Key`,
  dashboard cookie and CSRF; unauthenticated requests receive 401 JSON): the digest covers the
  expected current revision and the exact decimal source revision. A restore
  writes the next content Revision with `restored_from` provenance; a
  same-snapshot restore is the approved unchanged no-op (`changed:false`, no
  new revision) and still records a successful operation. Missing or
  payload-less (future purge tombstone) sources are
  `404 RESTORE_SOURCE_INVALID` and can never serve as restore origins.
  Restores never move URL, password, expiry, access revision, publication
  state, Favorite or view counts.

Static PUT field validation runs before digest normalization and result lookup.
Malformed content/metadata/policy fields receive a controlled 400 on both fresh
requests and retries; a committed ID never bypasses validation. Idempotent PUT
accepts only content fields, optional `codeType`, and the `_csrf` transport field;
policy controls (even `revokeAccess:false`, an access baseline, or an empty password)
and unsupported fields receive `400 UNSUPPORTED_REQUEST_ID_SCOPE` when otherwise
well-formed. Valid headerless content/policy/combined saves remain supported.

After static validation, replays run BEFORE any share read or CAS: a committed save or restore
confirms its ORIGINAL result even when the retried `If-Match` is long stale
(`replayed: true`; the response content comes from the committed snapshot
row plus the operation record, never from the owner's later edits). The
encrypted receipt stores `changed` plus the policy display values committed
with the result; the decrypted password is shown on replay only while the
access policy is unchanged — the same rule that gates generated-password
replay on creates. Result-unavailable answers `410 RESULT_UNAVAILABLE`.

Browser identity follows the #32 discipline, scoped per (kind, share):
an unconfirmed (lost-response) save or restore retries with its ORIGINAL
request id; a changed draft is a new explicit intent; an intent minted under
a different dashboard session is orphaned — kept read-only, never claimed.
`401/403/409/410/412/428` are never auto-retried and never switch baselines.
Errors (including 5xx and unreadable success responses) retain the original
id; only confirmed success or explicit user discard clears it. The draft
stays in the current editor on failure. Session storage holds the request
identity and exact draft key; it does not automatically restore editor fields
or upgrade the authorized baseline after navigation. If storage is denied,
the same-page in-memory identity still supports retry. A separate discard
control requires confirmation and preserves the editor's content; discarding
an id cannot undo a possibly committed operation. The explicit conflict
resolution action authorizes a new baseline; transport failure retains that
chosen baseline and id for retry.

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
| `dashboard-session:<fp>` | owner dashboard clone, content save and restore (session fingerprint) | one login session |
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
4. operation lookup (replay decision BEFORE expiry checks, clone source
   re-reads, restore source re-reads and any content CAS)
5. Share rows (batch deletes use sorted ids), Revision, audit, grant-free
   creation writes
6. operation record insert (unique constraint is the final guard)

The response is constructed only after COMMIT. There is no running state: a
crash leaves either nothing or a fully committed result, never a task to
recover.

## Replays and receipts

- A creation replay confirms the ORIGINAL committed result: its response
  metadata (isProtected, codeType, title, description, expiresAt, markdownTheme)
  comes from the encrypted receipt — the result exactly as committed.
  Dashboard save/restore instead uses the committed snapshot for content
  fields and the receipt for `changed` and access-policy display fields. A
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
- Purging a revision (#34) scrubs `receipt_encrypted` and sets `purged_at`
  for exactly the operations whose committed result is that Share+Revision,
  in the same transaction as the snapshot payload clearing — across every
  actor namespace; other revisions and other Shares keep their receipts and
  `deleted_at` stays the whole-Share marker. Replays of those operations
  confirm the operation happened but answer `410 RESULT_UNAVAILABLE` without
  returning any receipt or payload byte.

## Owner review

The dashboard's Share list has a “按请求标识核对创建操作” panel backed by
`GET /admin/operations?requestId=…`. It lists every namespace's record for
that id with status, action (`create`, `clone`, `content-update`, `restore`)
and Share/version metadata. Owner review never returns receipts; it cannot
be used to replay secrets across identities.

## Backup and restore

`publish_operations` rows (including encrypted receipts, #33 restore and
content-update rows, deletion tombstones, and #34 receipt-purged rows with
`purged_at`) are part of the full backup inventory
and are compared column-by-column by `scripts/verify-backup.js`
(`publishOperations` check); the backup drill seeds named restore/
content-update rows and a #34 receipt-scrubbed row whose receipt or
tombstone tampering fails verification by request id. Restored snapshots
keep `safeToServe: false` and owner-review reconciliation semantics; a
`page.revision.purge` audit event recorded after the snapshot point marks
the restore `unreconciled`. See [backup-restore](backup-restore.md).
