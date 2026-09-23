# Publish operations: create, conditional content updates, dashboard save/restore and status confirmation

Scope: this document describes **what is implemented** — idempotent creation
(web page, dashboard clone, Share API), managed-Key conditional content
updates (#37) and history restore (#38), idempotent dashboard content updates
and history restores (#33), operation status confirmation, and the deletion
tombstone. Key-driven publish-state writes remain unavailable.

## Request identity

- `Idempotency-Key` (Share API creation/update/restore, web creation,
  dashboard content save and restore) / `requestId` form field (dashboard clone):
  16–128 ASCII letters,
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

## Managed Key content update (#37)

`PUT /api/v1/shares/:id/content` is available only to a managed Key with both
`share:read` and `share:update` scopes AND the current per-Share read+update
grant. Edit implies read. Legacy environment Keys and browser/session
identities cannot use this route. `GET /api/v1/shares/:id/content` supplies the
strong content ETag; the update requires that concrete ETag in `If-Match` and
a mandatory `Idempotency-Key`. Missing either header is 428, malformed
request IDs or ETags are 400, and a stale baseline is 412. Wildcard, weak and
multi-tag conditions are rejected.

The request is a strict full snapshot with required own fields
`htmlContent`, `title`, `description`, and `markdownTheme`; `codeType` may be
omitted or equal the immutable existing type. Extra policy, access, favorite,
view-count and password fields are rejected rather than ignored. The exact
`htmlContent` string (including newline and Unicode representation) is stored
unchanged. Title and description follow the dashboard's existing trim/null
normalization; Markdown requires an existing theme preset, and non-Markdown
requires `markdownTheme: null`.

The normalized request digest covers action, target Share, exact body bytes,
field presence and the concrete expected content revision. The route reuses
the publishing operation lock, Key credential-version verification, Share
row lock, repository content CAS/no-op/revision behavior, `page.update` audit
and operation ledger. With a reused request id, current identity and edit
grant are checked first; a matching committed result is replayed before stale
CAS and returns the original content snapshot and same Share URL. A different
request returns 409; a deleted Share or purged result cannot be replayed and
returns 404/410. A new-id no-op is recorded with `changed:false` without
manufacturing a revision. Update operation receipts contain only the changed
flag; the bounded `GET /api/v1/operations/:requestId` projection has no body,
title, description, password or receipt and requires the current edit grant
for content-update records.

Dashboard controls at `/admin/apis` independently grant/revoke `can_update`
for one Share and toggle `auto_grant_new_share_edit`. Both use CSRF and audit
inside the publishing transaction. Update grant creation sets both
`can_read`/`can_update` and the read/update scopes; downgrading edit leaves
read permission and scope in place where another grant still requires them.
The auto option defaults off, affects only later creations by that managed
Key, and does not touch existing Shares, legacy Keys or frontend creates. A
managed API create reads the option after the Key lock and commits the page,
read+update grant, scopes, audit and create operation together. Any failure
rolls back the entire create transaction. Rotation preserves logical-key
permissions; revocation/deletion prevents future updates and update replays.

## Managed Key history reads and restore (#38)

`GET /api/v1/shares/:id/revisions` requires `share:read` plus the current
per-Share `can_read` grant. Its default page size is 20, maximum 100, and its
opaque cursor is a keyset over the exact decimal `BIGINT` revision in
descending order. The metadata-only projection contains revision, creation
time, write source, restore origin and current/purged markers; it never
aggregates snapshot bodies or returns title, hash, actor identity, credentials,
grants or Favorite state. New higher revisions do not shift an existing
cursor walk. `GET /api/v1/shares/:id/revisions/:revision` reads one authorized
canonical snapshot. Unknown revisions are 404; a purged tombstone is 410 with
non-content identity only. Both routes are private/no-store and ignore public
visibility, password and expiry policy after grant authorization.

`POST /api/v1/shares/:id/restore` requires a managed Key with both
`share:read` and `share:update`, the current `can_read` + `can_update` grant,
a concrete strong current-content `If-Match`, and a mandatory
`Idempotency-Key`. The request uses `smallRequestBodyBytes` (16 KiB by default),
returning 413 when exceeded; the 2 MiB Share-body parser remains in place for
content updates and Dashboard restore. The only business field is `revision`,
accepted as a positive safe JSON integer or canonical positive decimal string
(use strings above `Number.MAX_SAFE_INTEGER`). Digest identity covers target,
exact source revision and expected current revision. A missing source is 404; a purged
source is 410; stale content is 412. No URL, protection/password, expiry,
publication, grant, Favorite or view-count field is restored or changed.
The existing publishing transaction rechecks the Key version, serializes on
the operation id and Share row, performs the dashboard repository's locked
CAS/no-op restore, and commits provenance, `page.restore` audit and operation
record atomically. A changed restore creates a new content Revision with
`source='api-restore'`, `actor='api-key:<id>'`, and `restored_from` set to the
source revision; an identical snapshot returns `changed:false` without a new
Revision.

A matching retry is confirmed before stale CAS only after current Key and
edit-grant checks. Its response is reconstructed from the committed result
Revision, never the current projection. The encrypted receipt stores only
`changed` and the source revision. If either the source or result Revision is
later purged, replay returns 410 without content or receipt bytes. A deleted
Share or withdrawn grant fails the current authorization check as 404 before
replay. `GET /api/v1/operations/:requestId` is namespace-bound and
metadata-only; for restore it rechecks the current edit grant and source/result
availability, returning 404 for a missing/unauthorized operation and 410 when
its result is unavailable. This does not add a Key purge endpoint.

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

Dashboard static PUT field validation runs before digest normalization and result
lookup. Malformed content/metadata/policy fields receive a controlled 400 on both
fresh requests and retries; a committed ID never bypasses validation. The
idempotent dashboard PUT accepts only content fields, optional `codeType`, and
the `_csrf` transport field; policy controls (even `revokeAccess:false`, an
access baseline, or an empty password) and unsupported fields receive
`400 UNSUPPORTED_REQUEST_ID_SCOPE` when otherwise well-formed. The managed-Key
API is separate: it requires the strict four-field full snapshot described above
and accepts no CSRF or extra fields. Valid headerless dashboard saves remain
supported.

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

## Owner publish-state transitions (#35)

Two dashboard actions complete the lifecycle: **`unpublish`**
(`POST /admin/pages/:id/unpublish`) and **`republish`**
(`POST /admin/pages/:id/republish`), both behind the dashboard session,
CSRF, a REQUIRED `Idempotency-Key` and a REQUIRED `expectedAccessRevision`
(428 missing / 400 malformed). The digest covers the exact expected access
revision with the ACTION carrying the transition target, so the two actions
never share digest space.

One atomic publishing transaction per transition (lock order below): the
Share row is locked, the baseline is re-checked inside the lock (stale →
`412 ACCESS_REVISION_CONFLICT`), then `published` and `access_revision`
advance together in one statement. Nothing else moves: password, expiry,
content revisions, history, Favorite Share and view counts are untouched,
and a missing Share is a controlled `404 SHARE_NOT_FOUND`.

- Same-state repeat with a NEW request id records a successful no-op:
  `changed: false`, no bump, no duplicate audit entry.
- A lost response retried with the ORIGINAL id and ORIGINAL (now stale)
  baseline replays the committed result BEFORE any CAS (`replayed: true`) —
  the result is confirmed from the ledger record plus its encrypted receipt
  (`{changed, published}`), never re-derived from the live row. A publish-
  state result is a STATE transition: its confirmation does not depend on
  the committed content revision's availability, so a later purge of that
  revision cannot un-confirm it (the approved exception to the content-
  family revision check; conflicts and result-unavailable answers behave
  exactly as for every other action).
- The ledger row records the then-current content revision as owner-review
  metadata; the transition itself never moves it.
- Audit: `page.unpublish` / `page.republish`, committed in the same
  transaction. Both are hard revocation evidence for backup reconciliation
  (see [backup-restore](backup-restore.md)).
- The write-maintenance gate applies like every publishing write; paused
  writes answer `503 PUBLISHING_MAINTENANCE`.

**Public semantics (unified, #24 §5):** the adapters' public read seam
(`getPublicById`) never exposes an unpublished Share — every public surface
(view page, OG, metadata API, password POST) answers the neutral missing
404, with no content-derived metadata in any 404/410 path. Unpublished is
evaluated BEFORE expiry, so expiry only ever classifies published Shares
and an expired+unpublished Share reads as 404. View events never count an
unpublished Share (`404`, no increment), including while writes are paused.
Both transitions bump the access revision, so unlock cookies minted under
an older revision are dead after either one (#25 version-bound check);
republishing resumes the SAME URL with the password and expiry unchanged.

The owner dashboard keeps read, edit, history, restore, favorite and clone
for unpublished and expired Shares; only the public projection narrows.
The list and detail views render the published/unpublished state with the
toggle actions; each click carries the row's displayed access revision as
the baseline and an operation id in the dashboard-session namespace.

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
5. Share and grant rows (batch deletes use sorted ids), Revision, audit;
   create auto-edit grants/scopes are written on the same transaction client
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
that id with status, action (`create`, `clone`, `content-update`, `restore`,
`unpublish`, `republish`) and Share/version metadata. Owner review never
returns receipts; it cannot be used to replay secrets across identities.

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
