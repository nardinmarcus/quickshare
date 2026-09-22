# Share access revision rollout (#25 / #26)

## Contract

- `pages.access_revision` is `BIGINT NOT NULL DEFAULT 1`, positive, and travels as a canonical decimal string (`accessRevision`). Migration `004_page_access_revision.sql` preserves existing Share IDs, URLs, content, passwords, expiry and Favorite Share state.
- New signed `page_access_<id>` cookies bind both Share ID and access revision; TTL remains 24 hours. Legacy cookies and cookies from an earlier revision require another password unlock. A password form may return HTTP 200: successful revocation means no protected body and no view increment, not necessarily a GET 403.
- Password setting/replacement/removal, changed expiry and explicit owner revocation advance the revision atomically with the update. Unchanged policy, content-only and Favorite Share updates do not advance it. Explicit password setting counts as a policy change even when the plaintext is the same.
- Owner detail embeds its read baseline. Combined content/policy saves and the revoke button send `expectedAccessRevision`; they must not fetch a newer baseline automatically. A failed save keeps the draft. Revocation is disabled during editing so it cannot silently advance that draft's baseline.
- Existing `POST /api/pages/:id/protect` callers must first retain the `accessRevision` from their explicitly authenticated `GET /api/pages/:id/protect` response (`{ success: true, accessRevision: "1" }`) and send that exact string as `expectedAccessRevision`. This private/no-store baseline read uses the same frontend owner session authorization as the protection write; it returns no title, description, source, password or other Share metadata, and remains available for expired Shares. Anonymous visitors, visitor unlock cookies and create-only API Keys do not authorize it. Dashboard detail continues to embed its own baseline. Do not silently fetch a new baseline to retry a stale save. A successful protection update returns its committed revision, not a later concurrent writer's revision. Write authentication and CSRF requirements are unchanged.
- Public `GET /api/pages/:id` and `GET /view/:id` share one projection: missing is 404, expired is 410, locked metadata is 403 and the locked view is a neutral password form. Errors and locked HTML source/OG use no content-derived metadata; the site identity icon remains the generic cover. Only a valid current-version visitor unlock permits protected public metadata/content. Owner sessions and API Keys are not visitor unlocks; visitor unlocks do not authorize management. Ordinary public Share titles/descriptions remain intact. All these responses are private/no-store; third-party cached cards cannot be recalled.
- Missing policy precondition returns 428 (`ACCESS_PRECONDITION_REQUIRED`); malformed/noncanonical/out-of-range revision returns 400 (`INVALID_ACCESS_REVISION`); stale baseline returns 412 (`ACCESS_REVISION_CONFLICT`). A rejected combined save changes neither content nor policy. Content-only updates remain supported without an access condition.
- The password verifier captures the revision with the hash before asynchronous verification. It never signs a subsequently fetched revision. `GET /view/:id` remains read-only. View-event success is one conditional UPDATE, checking current published/expiry/protection/revision without rereading the body.

## Publication transitions (#35)

Owner unpublish and republish each advance the access revision atomically
with the `published` flip in one transaction. Version-bound cookies minted
under an older revision are dead after EITHER transition — unpublishing
makes every public surface answer the neutral missing 404, and republishing
reopens the SAME URL with the password and expiry unchanged but every old
unlock cookie dead. Neither transition touches password, expiry, content
revisions, history, Favorite Share, view counts or grants.

Public ordering is fixed and neutral: the public read seam never exposes an
unpublished Share, so unpublished/missing/deleted answer 404 BEFORE any
expiry classification — expiry only ever applies to published Shares, and
an expired+unpublished Share reads as 404. No 404/410 path leaks
title/description/body; locked metadata stays 403 with no content-derived
fields. View events check `published` in their conditional UPDATE: an
unpublished Share is never counted (404), including while writes are paused.

Owner unpublish/republish requests carry a required request id and the
displayed `expectedAccessRevision`; stale baselines answer 412 and a lost
response replays the committed result from the operation ledger. See
[publishing-operations](publishing-operations.md) for the full action
contract.

These slices do **not** introduce content Revisions, grants or maintenance mode. Shared deployment/backup documentation is owned by #27.

## Separately authorized deployment procedure

These are operator instructions, not evidence that production actions have occurred.

1. Retain a verified backup/restore point and required signing/encryption material using the backup procedure. Do not expose credentials or decrypted passwords in logs.
2. Rehearse on an isolated database. Apply the additive migration with the existing explicit runner (`npm run db:migrate`), using a temporary direct-owner migration credential, never a runtime credential with DDL privileges. Repeat it: `004` must be skipped on the second run. Application startup and requests must not execute DDL.
3. Verify the migration ledger, positive/non-null access revisions, existing IDs, row counts, content and protection state. Existing rows start at revision 1. Keep the schema expansion even if release is postponed.
4. Before enabling the new protocol, isolate and drain old deployments/writers. Hosting-level isolation or a separately delivered maintenance mechanism must prevent old requests from accepting legacy cookies or changing policy without advancing the revision. Do not treat rolling deployment readiness as proof that old requests have ended. If old instances cannot be excluded, do not open the new release.
5. Deploy the compatible candidate to the isolated preview, then perform the separately authorized production cutover. Expire cached owner pages/assets or require an explicit reload; stale clients must receive 428/412 rather than being assigned a fresh baseline. Legacy unlock cookies intentionally fail after cutover.
6. Check password rotation, off→on, expiry change and explicit revocation; ensure each old cookie fails both body access and view counting. Confirm another Share remains accessible, ordinary content/Favorite saves preserve access, normal protection saves work, and failed/stale saves retain inputs. Confirm GETs do not count views.

Useful schema readback (on the authorized target only):

```sql
SELECT version FROM quickshare_schema_migrations ORDER BY version;
SELECT data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pages'
  AND column_name = 'access_revision';
SELECT count(*) FROM pages WHERE access_revision IS NULL OR access_revision < 1;
```

## Safe rollback

- A failed migration transaction must roll back before serving new code. Fix the cause and rerun the explicit runner; do not add request/startup DDL.
- After access revisions are in use, **never roll back to code that ignores them**. Such a rollback can revive revoked cookies and allow unversioned policy writes even though the column remains present.
- A rollback candidate must retain revision-aware cookie verification, conditional policy updates and view-event checks. Keep migration 004 and its ledger entry; no destructive down migration and no counter reset.
- If no verified compatible rollback candidate exists, keep affected access and writes isolated and forward-fix. This ticket does not supply a maintenance switch; use the separately authorized operational isolation mechanism, not an invented application setting.
- Restoring an older backup is not permission to resume serving it: it may restore earlier passwords and revisions. Reconcile later revocations/protection changes before reopening; without reliable reconciliation, remain isolated for owner recovery. Preserve the signing secret required for decryption and rotate/invalidate access only through a reviewed recovery procedure.

## Local verification

Use only localhost and a ticket-specific database ending `_test`. The integration suite recreates `public`; never point it at production or another worker's database. Tests of concurrency require two independently checked-out backend connections.

```sh
# Clear inherited production database configuration for every test invocation.
env -u DATABASE_URL -u POSTGRES_URL -u DATABASE_MIGRATION_URL \
  -u DATABASE_URL_UNPOOLED -u POSTGRES_URL_NON_POOLING npm test

# Set POSTGRES_TEST_URL explicitly to your disposable PostgreSQL 17 database.
env -u DATABASE_URL -u POSTGRES_URL -u DATABASE_MIGRATION_URL \
  -u DATABASE_URL_UNPOOLED -u POSTGRES_URL_NON_POOLING \
  POSTGRES_TEST_URL='<localhost ticket-specific _test URL>' npm run test:postgres
```

`test/access-revision.test.js` exercises HTTP access revocation/preconditions, `test/access-revision-ui.test.js` exercises baseline/draft behavior, and `test/integration/postgres-migrations.test.js` covers empty/legacy/repeated migration and real conditional-write/view-event races. Browser acceptance uses a private synthetic fixture and isolated session; never production or a user's tabs.
