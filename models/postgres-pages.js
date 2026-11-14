const { createPostgresPool } = require('./postgres-config');
const {
  buildManagementDailyStats,
  managementDateRange,
  managementRecentStart
} = require('../utils/management-time');
const {
  accessRevisionMatches,
  nextAccessRevision,
  toAccessRevisionString
} = require('../utils/shareAccess');
const {
  computeSnapshotHash,
  contentRevisionMatches,
  contentSnapshotsEqual,
  nextContentRevision,
  toContentRevisionString
} = require('../utils/contentRevision');
const {
  ApiKeyCredentialChangedError,
  credentialVersionMatches,
  serializeApiKeyScopes
} = require('../utils/apiKeyIdentity');
const {
  grantPermissionsFromRow
} = require('../utils/shareGrants');
const { isPublishingPausedError } = require('../utils/publishing');
const {
  IdempotencyConflictError,
  requestHmacMatches
} = require('../utils/idempotency');
const { encryptSecret, generateId } = require('../utils/security');
const {
  acquirePublishingWriteGate,
  getPublishingWritesPaused,
  mapPublishingError,
  setPublishingWritesPaused,
  withPublishingWrite
} = require('./publishing');

function buildPageUpdateFields(options, startIndex = 1) {
  const fields = [];
  const params = [];
  let paramIndex = startIndex;

  if (options.title !== undefined) {
    fields.push(`title = $${paramIndex}`);
    params.push(options.title || null);
    paramIndex += 1;
  }
  if (options.description !== undefined) {
    fields.push(`description = $${paramIndex}`);
    params.push(options.description || null);
    paramIndex += 1;
  }
  if (options.htmlContent !== undefined) {
    fields.push(`html_content = $${paramIndex}`);
    params.push(options.htmlContent);
    paramIndex += 1;
  }
  if (options.expiresAt !== undefined) {
    fields.push(`expires_at = $${paramIndex}`);
    params.push(options.expiresAt || null);
    paramIndex += 1;
  }
  if (options.isProtected !== undefined) {
    fields.push(`is_protected = $${paramIndex}`);
    params.push(options.isProtected ? 1 : 0);
    paramIndex += 1;
    fields.push(`password_hash = $${paramIndex}`);
    params.push(options.passwordHash || null);
    paramIndex += 1;
    fields.push(`encrypted_password = $${paramIndex}`);
    params.push(options.encryptedPassword || null);
    paramIndex += 1;
  }
  if (options.markdownTheme !== undefined) {
    fields.push(`markdown_theme = $${paramIndex}`);
    params.push(options.markdownTheme || null);
    paramIndex += 1;
  }

  return { fields, params, nextParamIndex: paramIndex };
}

// The content fields that make up a Revision snapshot (T06), read from a
// pages row. Everything else on the row — protection, expiry, favorite,
// view count — is access/runtime state and never enters content history.
function rowContentFields(row) {
  return {
    htmlContent: row.html_content,
    codeType: row.code_type || 'html',
    title: row.title ?? null,
    description: row.description ?? null,
    markdownTheme: row.markdown_theme ?? null
  };
}

// Writes one immutable snapshot row for the page's given field set. The
// capture time is supplied by the caller: creation time for a create,
// edit time for an edit, and the backfill run's own time for a baseline —
// never silently the Share's original creation time when the snapshot is
// taken later.
async function insertContentSnapshotRow(client, pageRow, revision, meta = {}, capturedAt = Date.now()) {
  const fields = rowContentFields(pageRow);
  const revisionString = toContentRevisionString(revision);

  await client.query(
    `
      INSERT INTO share_revisions (
        share_id, revision, html_content, code_type, title, description,
        markdown_theme, snapshot_hash, source, actor_type, actor_id,
        restored_from_revision, created_at
      )
      VALUES ($1, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::bigint, $13)
    `,
    [
      pageRow.id,
      revisionString,
      fields.htmlContent,
      fields.codeType,
      fields.title,
      fields.description,
      fields.markdownTheme,
      computeSnapshotHash(pageRow.id, revisionString, fields),
      meta.source || 'admin-edit',
      meta.actorType || 'owner',
      meta.actorId ?? null,
      meta.restoredFromRevision ?? null,
      capturedAt
    ]
  );
}

// Establishes the Revision 1 baseline for a Share that predates the
// revision protocol (current_revision IS NULL), capturing its current
// materialized fields exactly as they are. Runs inside the caller's
// transaction; the row must already be locked by the caller. Returns true
// when a baseline was written.
async function ensureContentBaseline(client, pageRow, capturedAt = Date.now()) {
  if (toContentRevisionString(pageRow.current_revision) !== null) {
    return false;
  }

  await insertContentSnapshotRow(client, pageRow, '1', {
    source: 'baseline',
    actorType: 'operator'
  }, capturedAt);
  await client.query(
    'UPDATE pages SET current_revision = 1 WHERE id = $1',
    [pageRow.id]
  );
  pageRow.current_revision = '1';
  return true;
}

// Re-verifies, inside a publishing write transaction, the managed-Key
// credential version the request first authenticated with (T05). The
// spec's lock order is fixed: maintenance gate first (held by
// withPublishingWrite before this runs), then the managed Key row.
// Locking the Key row FOR UPDATE and comparing the stored
// credential_version means a rotation or delete that committed first
// refuses this write, and a rotation that arrives later waits for this
// transaction instead of slipping in underneath it. Legacy credentials
// have no row and nothing to re-verify.
async function recheckManagedCredential(client, credential) {
  if (!credential || credential.type !== 'managed') {
    return;
  }

  const keyResult = await client.query(
    `
      SELECT credential_version::text AS credential_version
      FROM api_keys
      WHERE id = $1
      FOR UPDATE
    `,
    [credential.keyId]
  );
  const currentVersion = keyResult.rows[0]?.credential_version;

  if (currentVersion === undefined
    || !credentialVersionMatches(currentVersion, credential.credentialVersion)) {
    throw new ApiKeyCredentialChangedError();
  }
}

// Auto-edit grants for a managed Key's own creations (T13, issue #37;
// parent spec #24 §6): when the Key's owner enabled
// auto_grant_new_share_edit, a Share created BY that Key receives
// read+update grants for the Key in the SAME transaction as the create
// — never publish, never retroactive (only creations committed while
// the flag is on). Runs inside the caller's create transaction, after
// recheckManagedCredential has locked the Key row, so the flag is read
// under the same lock that serializes rotation and flag changes. A
// plain INSERT is deliberate: a grant row that somehow already exists
// for the fresh Share ID is a data inconsistency, and its failure must
// roll the whole create back rather than silently keep a grant the
// create did not make. Returns true when grants were written.
async function insertAutoEditGrants(client, credential, shareId, now = Date.now()) {
  if (!credential || credential.type !== 'managed') {
    return false;
  }

  const keyResult = await client.query(
    'SELECT auto_grant_new_share_edit FROM api_keys WHERE id = $1',
    [credential.keyId]
  );

  if (keyResult.rows[0]?.auto_grant_new_share_edit !== true) {
    return false;
  }

  await client.query(
    `
      INSERT INTO public.share_grants (
        api_key_id, share_id, can_read, can_update, can_publish, created_at, updated_at
      )
      VALUES ($1, $2, TRUE, TRUE, FALSE, $3, $3)
    `,
    [credential.keyId, shareId, now]
  );

  return true;
}

// Inserts the Share row itself (no snapshot). The caller owns the
// transaction and writes the Revision baseline right after, so a Share
// never exists without its baseline once this code writes it.
async function insertPageRow(client, page) {
  await client.query(
    `
      INSERT INTO pages (
        id, html_content, created_at, password_hash, encrypted_password, is_protected,
        code_type, title, description, expires_at, markdown_theme, access_revision,
        current_revision, published
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, 1, TRUE)
    `,
    [
      page.id,
      page.htmlContent,
      page.createdAt,
      page.passwordHash || null,
      page.encryptedPassword || null,
      page.isProtected ? 1 : 0,
      page.codeType || 'html',
      page.title || null,
      page.description || null,
      page.expiresAt || null,
      page.markdownTheme || null
    ]
  );
}

// --- Publish operation records (T08, issue #32) ---------------------------
//
// One row per committed create/clone, keyed by (actor_namespace,
// request_id). The row is written in the same transaction as the Share,
// its Revision 1 snapshot and the create audit. A per-request advisory
// transaction lock — taken after the maintenance gate and the managed
// Key lock, per the parent spec's fixed lock order — serializes
// concurrent submissions of the same identifier, so the second one
// observes the committed record and replays it; the PRIMARY KEY remains
// the final dedup guard underneath.

// One share_grants row (T12) in the shape the routes and the admin
// panel consume: identifiers, the three resource permissions (with the
// update-implies-read invariant applied on read as well as on write, so
// a hand-edited row can never understate an editor's read access) and
// the grant timestamps as epoch numbers.
function normalizeGrantRow(row) {
  if (!row) {
    return null;
  }

  return {
    keyId: row.api_key_id,
    shareId: row.share_id,
    permissions: grantPermissionsFromRow(row),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function operationLockKey(operation) {
  return `quickshare:publish-operation:${operation.actorNamespace}:${operation.requestId}`;
}

async function acquireOperationLock(client, operation) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [operationLockKey(operation)]
  );
}

function normalizeOperationRow(row) {
  if (!row) {
    return null;
  }

  return {
    actorNamespace: row.actor_namespace,
    requestId: row.request_id,
    action: row.action,
    targetId: row.target_id ?? null,
    requestHmac: row.request_hmac,
    resultShareId: row.result_share_id ?? null,
    resultRevision: row.result_revision == null ? null : String(row.result_revision),
    resultAccessRevision: row.result_access_revision == null
      ? null
      : String(row.result_access_revision),
    receiptEncrypted: row.receipt_encrypted ?? null,
    resultState: row.result_state,
    createdAt: Number(row.created_at)
  };
}

async function findOperationRow(client, actorNamespace, requestId) {
  const result = await client.query(
    `
      SELECT actor_namespace, request_id, action, target_id, request_hmac,
        result_share_id, result_revision::text AS result_revision,
        result_access_revision::text AS result_access_revision,
        receipt_encrypted, result_state, created_at
      FROM public.publish_operations
      WHERE actor_namespace = $1 AND request_id = $2
      LIMIT 1
    `,
    [actorNamespace, requestId]
  );

  return normalizeOperationRow(result.rows[0]);
}

async function insertOperationRow(client, operation) {
  await client.query(
    `
      INSERT INTO public.publish_operations (
        actor_namespace, request_id, action, target_id, request_hmac,
        result_share_id, result_revision, result_access_revision,
        receipt_encrypted, result_state, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8::bigint, $9, $10, $11)
    `,
    [
      operation.actorNamespace,
      operation.requestId,
      operation.action,
      operation.targetId ?? null,
      operation.requestHmac,
      operation.resultShareId ?? null,
      operation.resultRevision ?? null,
      operation.resultAccessRevision ?? null,
      operation.receipt ? encryptSecret(JSON.stringify(operation.receipt)) : null,
      operation.resultState || 'committed',
      operation.createdAt
    ]
  );
}

// The replay-time availability/policy view of a committed operation's
// result (parent spec §8): whether the Share still exists, its CURRENT
// access revision and protection flag, and whether the result Revision's
// snapshot payload still exists. A purged snapshot (T10) leaves a
// tombstone row behind, but its payload is gone, so for replay purposes
// the version counts as cleared: only a row that still carries its body
// satisfies this check. The receipt is only honored as far as this
// current state allows — a changed access policy never gets the old
// password back.
async function loadResultShareState(client, operation) {
  const result = await client.query(
    `
      SELECT p.access_revision::text AS access_revision, p.is_protected,
        EXISTS (
          SELECT 1 FROM public.share_revisions r
          WHERE r.share_id = p.id AND r.revision = $2::bigint
            AND r.html_content IS NOT NULL
        ) AS revision_exists
      FROM public.pages p
      WHERE p.id = $1
      LIMIT 1
    `,
    [operation.resultShareId, operation.resultRevision]
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    exists: true,
    accessRevision: row.access_revision,
    isProtected: row.is_protected === 1,
    revisionExists: row.revision_exists === true
  };
}

// Shared lookup discipline for an idempotent write: with the operation
// lock held, an existing record decides the outcome before any new work
// happens. Returns null when the caller should proceed as a first
// execution; throws IdempotencyConflictError for same identifier /
// different input; otherwise returns the replay outcome.
async function resolveExistingOperation(client, operation) {
  const existing = await findOperationRow(client, operation.actorNamespace, operation.requestId);

  if (!existing) {
    return null;
  }

  if (!requestHmacMatches(existing.requestHmac, operation.requestHmac)) {
    throw new IdempotencyConflictError();
  }

  if (existing.resultState !== 'committed') {
    return { outcome: 'unavailable', operation: existing, shareState: null };
  }

  const shareState = await loadResultShareState(client, existing);
  return {
    outcome: 'replayed',
    operation: existing,
    shareState
  };
}

function buildAdminPageFilter(options = {}) {
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  if (options.search) {
    conditions.push(`(id ILIKE $${paramIndex} OR title ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`);
    params.push(`%${options.search}%`);
    paramIndex += 1;
  }

  if (options.codeType) {
    conditions.push(`code_type = $${paramIndex}`);
    params.push(options.codeType);
    paramIndex += 1;
  }

  if (options.isProtected !== undefined && options.isProtected !== '') {
    conditions.push(`is_protected = $${paramIndex}`);
    params.push(options.isProtected === true || options.isProtected === 'true' || options.isProtected === 1 || options.isProtected === 'protected' ? 1 : 0);
    paramIndex += 1;
  }

  if (options.isFavorite === true) {
    conditions.push('is_favorite = TRUE');
  }

  if (options.dateFrom) {
    const fromTime = managementDateRange(options.dateFrom)?.start;
    if (Number.isFinite(fromTime)) {
      conditions.push(`created_at >= $${paramIndex}`);
      params.push(fromTime);
      paramIndex += 1;
    }
  }

  if (options.dateTo) {
    const toTime = managementDateRange(options.dateTo)?.end;
    if (Number.isFinite(toTime)) {
      conditions.push(`created_at <= $${paramIndex}`);
      params.push(toTime);
      paramIndex += 1;
    }
  }

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
    nextParamIndex: paramIndex
  };
}

class PostgresPageRepository {
  constructor(connectionString, env = process.env) {
    if (!connectionString) {
      throw new Error('DATABASE_URL is required for PostgresPageRepository');
    }

    this.pool = createPostgresPool(connectionString, { env });
  }

  async init() {
    // Schema changes are applied only through `npm run db:migrate`.
  }

  async getHomepagePasswordRequired() {
    const result = await this.pool.query(
      'SELECT homepage_password_required FROM site_settings WHERE id = 1 LIMIT 1'
    );
    const passwordRequired = result.rows[0]?.homepage_password_required;

    if (typeof passwordRequired !== 'boolean') {
      throw new Error('Homepage access setting is unavailable');
    }

    return passwordRequired;
  }

  async getPublishingWritesPaused() {
    return getPublishingWritesPaused(this.pool);
  }

  async setPublishingWritesPaused({ paused, ip } = {}) {
    return setPublishingWritesPaused(this.pool, { paused, ip });
  }

  async setHomepagePasswordRequired({ passwordRequired, ip }) {
    if (typeof passwordRequired !== 'boolean') {
      throw new TypeError('passwordRequired must be a boolean');
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      // A management write: it passes the publishing maintenance gate
      // before touching the settings row (T04).
      await acquirePublishingWriteGate(client);
      const result = await client.query(
        'SELECT homepage_password_required FROM site_settings WHERE id = 1 FOR UPDATE'
      );
      const previousValue = result.rows[0]?.homepage_password_required;

      if (typeof previousValue !== 'boolean') {
        throw new Error('Homepage access setting is unavailable');
      }

      if (previousValue === passwordRequired) {
        await client.query('COMMIT');
        return { passwordRequired, changed: false };
      }

      const updatedAt = Date.now();
      await client.query(
        'UPDATE site_settings SET homepage_password_required = $1, updated_at = $2 WHERE id = 1',
        [passwordRequired, updatedAt]
      );
      await client.query(
        'INSERT INTO audit_logs (action, page_id, details, ip, created_at) VALUES ($1, $2, $3, $4, $5)',
        [
          'settings.homepage_password_required.update',
          null,
          JSON.stringify({ from: previousValue, to: passwordRequired }),
          ip || null,
          updatedAt
        ]
      );
      await client.query('COMMIT');

      return { passwordRequired, changed: true };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original transaction error.
      }
      throw mapPublishingError(error);
    } finally {
      client.release();
    }
  }

  async create(page, options = {}) {
    await withPublishingWrite(this.pool, async (client) => {
      // A managed-Key API write re-verifies its credential inside the
      // write transaction (T05), under the fixed lock order: gate, Key.
      await recheckManagedCredential(client, options.apiCredential);
      await insertPageRow(client, page);

      // Content Revision baseline (T06): the Revision 1 snapshot is part
      // of the same gated transaction as the Share itself, so a Share can
      // never exist without its baseline once this code writes it.
      await insertContentSnapshotRow(client, {
        id: page.id,
        html_content: page.htmlContent,
        code_type: page.codeType || 'html',
        title: page.title || null,
        description: page.description || null,
        markdown_theme: page.markdownTheme || null
      }, '1', options.revisionMeta || { source: 'web-create', actorType: 'owner' }, page.createdAt);

      // Auto-edit grants (T13): a managed Key whose owner opted in
      // receives read+update grants on its own new Share in this same
      // transaction; a failure here rolls the create back whole.
      await insertAutoEditGrants(client, options.apiCredential, page.id, page.createdAt);
    });

    return { id: page.id };
  }

  // Idempotent create (T08): when `operation` is present, the create runs
  // under the per-request lock and either replays the previously
  // committed result for the same identifier + input digest, refuses a
  // digest mismatch with IdempotencyConflictError, reports a tombstoned
  // result as 'unavailable', or executes exactly once — Share, Revision
  // 1 snapshot, create audit and the operation record committing
  // atomically in one gated transaction.
  //
  // `prepare()` is invoked ONLY on a first execution, inside the
  // transaction: every derived value (Share ID, generated password and
  // its hash, creation time, auto title) comes into existence after the
  // digest was computed and after the lookup missed, so a retry can
  // never produce different derived values for the same operation. It
  // returns { page, result } where result is the response payload stored
  // (encrypted) as the operation receipt.
  async createIdempotent({ operation = null, apiCredential, revisionMeta, audit, prepare }) {
    let lastError = null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await withPublishingWrite(this.pool, async (client) => {
          if (operation) {
            await acquireOperationLock(client, operation);
          }

          await recheckManagedCredential(client, apiCredential);

          if (operation) {
            const resolved = await resolveExistingOperation(client, operation);

            if (resolved) {
              return resolved;
            }
          }

          const prepared = await prepare();
          await insertPageRow(client, prepared.page);
          await insertContentSnapshotRow(client, {
            id: prepared.page.id,
            html_content: prepared.page.htmlContent,
            code_type: prepared.page.codeType || 'html',
            title: prepared.page.title || null,
            description: prepared.page.description || null,
            markdown_theme: prepared.page.markdownTheme || null
          }, '1', revisionMeta || { source: 'web-create', actorType: 'owner' }, prepared.page.createdAt);

          // Auto-edit grants (T13): only a first execution reaches
          // here — a replay resolved above returns before any insert,
          // so a retried create can never duplicate the grants.
          await insertAutoEditGrants(client, apiCredential, prepared.page.id, prepared.page.createdAt);

          if (audit) {
            await client.query(
              'INSERT INTO audit_logs (action, page_id, details, ip, created_at) VALUES ($1, $2, $3, $4, $5)',
              [audit.action, prepared.page.id, audit.details, audit.ip || null, Date.now()]
            );
          }

          let record = null;

          if (operation) {
            record = {
              ...operation,
              resultShareId: prepared.page.id,
              resultRevision: '1',
              resultAccessRevision: '1',
              receipt: prepared.result,
              resultState: 'committed',
              createdAt: Date.now()
            };
            await insertOperationRow(client, record);
          }

          return {
            outcome: 'created',
            page: prepared.page,
            result: prepared.result,
            operation: record
          };
        });
      } catch (error) {
        lastError = error;

        // Only a Share-ID collision is retried (with a freshly prepared
        // ID); every other failure — validation, conflict, gate — is
        // final for this attempt and propagates unchanged.
        if (error?.code !== '23505' || error?.constraint !== 'pages_pkey') {
          throw error;
        }
      }
    }

    throw lastError || new Error('Failed to create a unique page id');
  }

  // Clone with optional idempotency (T08). The source row is read FOR
  // UPDATE inside the same gated transaction that writes the copy, its
  // Revision 1 baseline and (when an operation identifier is present)
  // the operation record, so a cloned result and its dedup record can
  // never diverge. `buildClone(sourceRow)` returns the copy's content
  // fields ({ htmlContent, codeType, title, description, markdownTheme }).
  async clonePage({ sourceId, operation = null, buildClone, audit }) {
    let lastError = null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await withPublishingWrite(this.pool, async (client) => {
          if (operation) {
            await acquireOperationLock(client, operation);

            const resolved = await resolveExistingOperation(client, operation);

            if (resolved) {
              return resolved;
            }
          }

          const sourceResult = await client.query(
            'SELECT * FROM pages WHERE id = $1 FOR UPDATE',
            [sourceId]
          );
          const source = sourceResult.rows[0];

          if (!source) {
            const error = new Error('Clone source not found');
            error.code = 'share_not_found';
            throw error;
          }

          const fields = buildClone(source);
          const newId = generateId();
          const createdAt = Date.now();
          const page = {
            id: newId,
            htmlContent: fields.htmlContent,
            passwordHash: null,
            encryptedPassword: null,
            isProtected: false,
            codeType: fields.codeType || 'html',
            title: fields.title || null,
            description: fields.description ?? null,
            createdAt,
            expiresAt: null,
            markdownTheme: fields.markdownTheme ?? null
          };

          await insertPageRow(client, page);
          await insertContentSnapshotRow(client, {
            id: newId,
            html_content: page.htmlContent,
            code_type: page.codeType,
            title: page.title,
            description: page.description,
            markdown_theme: page.markdownTheme
          }, '1', { source: 'admin-clone', actorType: 'owner' }, createdAt);

          if (audit) {
            await client.query(
              'INSERT INTO audit_logs (action, page_id, details, ip, created_at) VALUES ($1, $2, $3, $4, $5)',
              [audit.action, newId, audit.details, audit.ip || null, Date.now()]
            );
          }

          let record = null;

          if (operation) {
            record = {
              ...operation,
              resultShareId: newId,
              resultRevision: '1',
              resultAccessRevision: '1',
              receipt: { kind: 'share.clone', shareId: newId },
              resultState: 'committed',
              createdAt: Date.now()
            };
            await insertOperationRow(client, record);
          }

          return { outcome: 'created', id: newId, operation: record };
        });
      } catch (error) {
        lastError = error;

        if (error?.code !== '23505' || error?.constraint !== 'pages_pkey') {
          throw error;
        }
      }
    }

    throw lastError || new Error('Failed to create a unique page id');
  }

  // Idempotent admin content save (T09, issue #33): same contract as
  // the memory Adapter. Under the fixed lock order (maintenance gate,
  // then the per-request operation lock, then the Share row) the
  // committed operation is resolved BEFORE any version precondition is
  // judged — a digest-matching record replays its original result even
  // though the request's If-Match has since gone stale — and only a
  // first execution reaches applyPageUpdate. A successful save (changed
  // or unchanged) records its result in the same transaction as the
  // projection, snapshot and audit; failures record nothing.
  // `apiCredential` + `grantCheck` serve the Key-authenticated content
  // update (T13, issue #37): before any replay is honored or any
  // version precondition is judged, the transaction re-verifies the
  // credential version it first authenticated with (T05's recheck,
  // which also takes the Key row lock) and re-reads the caller's grant
  // on this Share under that lock. A rotation, deletion or revocation
  // that committed first therefore refuses the in-flight write — a
  // revoked Key cannot even replay its own earlier result (parent spec
  // #24 §8) — while one that arrives later waits behind this
  // transaction. Dashboard callers pass neither and keep T09 behavior.
  async saveContentIdempotent({ id, options, precondition = {}, operation = null, apiCredential = null, grantCheck = null }) {
    return withPublishingWrite(this.pool, async (client) => {
      if (operation) {
        await acquireOperationLock(client, operation);
      }

      await recheckManagedCredential(client, apiCredential);

      if (grantCheck) {
        const grantResult = await client.query(
          `
            SELECT can_read, can_update, can_publish
            FROM public.share_grants
            WHERE api_key_id = $1 AND share_id = $2
            LIMIT 1
          `,
          [grantCheck.keyId, id]
        );
        const permissions = grantPermissionsFromRow(grantResult.rows[0]);

        if (!permissions[grantCheck.permission]) {
          return {
            outcome: 'executed',
            result: {
              status: 'grant_not_found',
              accessRevision: null,
              contentRevision: null,
              contentChanged: false,
              current: null
            }
          };
        }
      }

      if (operation) {
        const resolved = await resolveExistingOperation(client, operation);

        if (resolved) {
          return resolved;
        }
      }

      const result = await this.applyPageUpdate(client, id, options, precondition);

      if (!operation || result.status !== 'updated') {
        return { outcome: 'executed', result };
      }

      const record = {
        ...operation,
        resultShareId: id,
        resultRevision: result.contentRevision,
        resultAccessRevision: result.accessRevision,
        receipt: {
          kind: 'share.content.update',
          shareId: id,
          contentChanged: result.contentChanged === true,
          contentRevision: result.contentRevision,
          accessRevision: result.accessRevision
        },
        resultState: 'committed',
        createdAt: Date.now()
      };
      await insertOperationRow(client, record);

      return { outcome: 'executed', result, operation: record };
    });
  }

  // Idempotent history restore (T09, issue #33): same contract as the
  // memory Adapter. The Share row is locked first; the source snapshot
  // is then read and judged inside the same transaction, so the source
  // read, the current-version precondition, the projection write, the
  // new snapshot (with its restore provenance), the audit and the
  // operation record commit — or roll back — together. Only content
  // fields move: URL, password, expiry, access_revision, Key
  // authorization, publish state, favorite and view count are never
  // written here. A snapshot whose payload was cleared (a purge
  // tombstone) is not a valid restore source.
  // `apiCredential` + `grantCheck` + `restoreMeta` serve the
  // Key-authenticated restore (T14, issue #38), under the same
  // discipline as the T13 content update: after the operation lock,
  // the transaction re-verifies the credential version (taking the Key
  // row lock) and re-reads the caller's grant BEFORE any replay is
  // honored or any precondition is judged, so a rotation, deletion or
  // revocation that committed first refuses the in-flight restore and
  // a revoked Key cannot replay its own earlier result (parent spec
  // #24 §8). `restoreMeta` names the snapshot provenance for the API
  // actor (source 'api-restore', actorType 'api_key'); dashboard
  // callers pass none of these and keep the T09 owner provenance.
  async restoreRevision({ id, sourceRevision, precondition = {}, operation = null, apiCredential = null, grantCheck = null, restoreMeta = null }) {
    const sourceRevisionString = toContentRevisionString(sourceRevision);

    return withPublishingWrite(this.pool, async (client) => {
      if (operation) {
        await acquireOperationLock(client, operation);
      }

      await recheckManagedCredential(client, apiCredential);

      if (grantCheck) {
        const grantResult = await client.query(
          `
            SELECT can_read, can_update, can_publish
            FROM public.share_grants
            WHERE api_key_id = $1 AND share_id = $2
            LIMIT 1
          `,
          [grantCheck.keyId, id]
        );
        const permissions = grantPermissionsFromRow(grantResult.rows[0]);

        if (!permissions[grantCheck.permission]) {
          return {
            outcome: 'executed',
            result: {
              status: 'grant_not_found',
              accessRevision: null,
              contentRevision: null,
              contentChanged: false,
              current: null
            }
          };
        }
      }

      if (operation) {
        const resolved = await resolveExistingOperation(client, operation);

        if (resolved) {
          return resolved;
        }
      }

      const selectResult = await client.query(
        'SELECT * FROM pages WHERE id = $1 FOR UPDATE',
        [id]
      );
      const row = selectResult.rows[0];

      if (!row) {
        return { outcome: 'executed', result: { status: 'not_found' } };
      }

      await ensureContentBaseline(client, row);

      const snapshotResult = await client.query(
        `
          SELECT html_content, code_type, title, description, markdown_theme
          FROM public.share_revisions
          WHERE share_id = $1 AND revision = $2::bigint
          LIMIT 1
        `,
        [id, sourceRevisionString]
      );
      const source = snapshotResult.rows[0];

      if (!source) {
        return { outcome: 'executed', result: { status: 'source_not_found' } };
      }

      if (source.html_content === null) {
        return { outcome: 'executed', result: { status: 'source_unavailable' } };
      }

      const previousRevision = toContentRevisionString(row.current_revision);
      const result = await this.applyPageUpdate(client, id, {
        htmlContent: source.html_content,
        title: source.title,
        description: source.description,
        markdownTheme: source.markdown_theme
      }, {
        ...precondition,
        expectedAccessRevision: null,
        advanceAccessRevision: false,
        contentMeta: {
          source: restoreMeta?.source || 'admin-restore',
          actorType: restoreMeta?.actorType || 'owner',
          actorId: restoreMeta?.actorId ?? null,
          restoredFromRevision: sourceRevisionString
        }
      }, row);
      const fullResult = {
        ...result,
        sourceRevision: sourceRevisionString,
        previousRevision
      };

      if (!operation || result.status !== 'updated') {
        return { outcome: 'executed', result: fullResult };
      }

      const record = {
        ...operation,
        resultShareId: id,
        resultRevision: result.contentRevision,
        resultAccessRevision: result.accessRevision,
        receipt: {
          kind: 'share.restore',
          shareId: id,
          sourceRevision: sourceRevisionString,
          previousRevision,
          contentRevision: result.contentRevision,
          contentChanged: result.contentChanged === true
        },
        resultState: 'committed',
        createdAt: Date.now()
      };
      await insertOperationRow(client, record);

      return { outcome: 'executed', result: fullResult, operation: record };
    });
  }

  // Publish-state transition (T11, issue #35): unpublish or republish a
  // Share without touching its content, password, expiry or history.
  // The transition and the "already in the target state" judgment run
  // under the Share row lock inside the publishing gate, so a state race
  // has exactly one winner per access-version precondition. A real
  // transition flips `published` and advances `access_revision` in the
  // same statement — every previously issued unlock cookie dies on BOTH
  // transitions and can never revive when the Share is republished —
  // and writes the `page.publish.update` audit in the same transaction.
  // Setting the state the Share already has is a successful no-op: no
  // access-version advance (parent spec §4: a completely unchanged
  // policy does not advance the version) and no audit, but a keyed
  // request still records its operation (parent spec §8), so a lost
  // response stays confirmable and a retry replays the recorded result.
  // Precondition failures (missing 428 / stale 412 family, judged here
  // against the locked row) record nothing. Replay resolution precedes
  // every judgment, exactly like restore.
  async setPublishedState({ id, published, precondition = {}, operation = null, ip = null }) {
    const targetPublished = published === true;
    const expected = precondition.expectedAccessRevision == null
      ? null
      : toAccessRevisionString(precondition.expectedAccessRevision);

    return withPublishingWrite(this.pool, async (client) => {
      if (operation) {
        await acquireOperationLock(client, operation);

        const resolved = await resolveExistingOperation(client, operation);

        if (resolved) {
          return resolved;
        }
      }

      const selectResult = await client.query(
        'SELECT * FROM pages WHERE id = $1 FOR UPDATE',
        [id]
      );
      const row = selectResult.rows[0];

      if (!row) {
        return { outcome: 'executed', result: { status: 'not_found' } };
      }

      const currentAccessRevision = toAccessRevisionString(row.access_revision);
      const currentPublished = row.published !== false;

      if (precondition.accessPreconditionMissing) {
        return {
          outcome: 'executed',
          result: { status: 'access_precondition_required', accessRevision: currentAccessRevision }
        };
      }

      if (expected === null || !accessRevisionMatches(currentAccessRevision, expected)) {
        return {
          outcome: 'executed',
          result: { status: 'conflict', accessRevision: currentAccessRevision }
        };
      }

      const changed = currentPublished !== targetPublished;
      let resultingAccessRevision = currentAccessRevision;

      if (changed) {
        const updateResult = await client.query(
          `
            UPDATE pages
            SET published = $2, access_revision = access_revision + 1
            WHERE id = $1
            RETURNING access_revision::text AS access_revision
          `,
          [id, targetPublished]
        );
        resultingAccessRevision = updateResult.rows[0].access_revision;

        await client.query(
          'INSERT INTO audit_logs (action, page_id, details, ip, created_at) VALUES ($1, $2, $3, $4, $5)',
          [
            'page.publish.update',
            id,
            JSON.stringify({
              from: currentPublished,
              to: targetPublished,
              accessRevision: resultingAccessRevision
            }),
            ip,
            Date.now()
          ]
        );
      }

      const result = {
        status: changed ? 'updated' : 'unchanged',
        published: targetPublished,
        changed,
        accessRevision: resultingAccessRevision,
        contentRevision: toContentRevisionString(row.current_revision)
      };

      if (!operation) {
        return { outcome: 'executed', result };
      }

      const record = {
        ...operation,
        resultShareId: id,
        resultRevision: null,
        resultAccessRevision: resultingAccessRevision,
        receipt: {
          kind: operation.action,
          shareId: id,
          published: targetPublished,
          changed,
          accessRevision: resultingAccessRevision
        },
        resultState: 'committed',
        createdAt: Date.now()
      };
      await insertOperationRow(client, record);

      return { outcome: 'executed', result, operation: record };
    });
  }

  // Permanent purge of one non-current Revision (T10, issue #34).
  // Owner-only and dashboard-only by route design — there is no
  // API-Key or CLI entry point. Inside one gated transaction the Share
  // row is locked first, so the current-version judgment and the
  // tombstone write are serialized against concurrent saves and
  // restores on the same Share lock order: a restore cannot slip a
  // purged source past its own in-lock read, and a version that becomes
  // current after this purge judged it non-current cannot exist (a
  // restore writes a NEW revision; it never promotes the target).
  // The same transaction clears the snapshot payload (body, title,
  // description, theme and the payload-derived hash), stamps purged_at,
  // scrubs the encrypted receipts of every committed operation whose
  // result is exactly this version (any credential namespace — those
  // receipts are the recoverable ciphertext that could re-emit the
  // purged version's title, description or generated password), and
  // writes the purge audit. The tombstone row itself, the version
  // number and all other Revisions are untouched; version numbers are
  // never reused. Repeating the purge of an already-purged Revision is
  // a no-op success that writes nothing.
  async purgeRevision({ id, revision, ip = null }) {
    const revisionString = toContentRevisionString(revision);

    if (revisionString === null) {
      return { status: 'revision_not_found', revision: null };
    }

    return withPublishingWrite(this.pool, async (client) => {
      const pageResult = await client.query(
        'SELECT id, current_revision FROM pages WHERE id = $1 FOR UPDATE',
        [id]
      );
      const page = pageResult.rows[0];

      if (!page) {
        return { status: 'not_found', revision: revisionString };
      }

      const snapshotResult = await client.query(
        `
          SELECT revision::text AS revision, html_content, purged_at
          FROM public.share_revisions
          WHERE share_id = $1 AND revision = $2::bigint
          FOR UPDATE
        `,
        [id, revisionString]
      );
      const snapshot = snapshotResult.rows[0];

      if (!snapshot) {
        return { status: 'revision_not_found', revision: revisionString };
      }

      if (snapshot.purged_at !== null || snapshot.html_content === null) {
        return {
          status: 'already_purged',
          revision: revisionString,
          purgedAt: snapshot.purged_at === null ? null : Number(snapshot.purged_at)
        };
      }

      if (contentRevisionMatches(page.current_revision, revisionString)) {
        return {
          status: 'current_revision',
          revision: revisionString,
          currentRevision: toContentRevisionString(page.current_revision)
        };
      }

      const purgedAt = Date.now();

      await client.query(
        `
          UPDATE public.share_revisions
          SET html_content = NULL, title = NULL, description = NULL,
              markdown_theme = NULL, snapshot_hash = NULL, purged_at = $3
          WHERE share_id = $1 AND revision = $2::bigint
        `,
        [id, revisionString, purgedAt]
      );

      const scrubResult = await client.query(
        `
          UPDATE public.publish_operations
          SET receipt_encrypted = NULL
          WHERE result_share_id = $1 AND result_revision = $2::bigint
            AND result_state = 'committed' AND receipt_encrypted IS NOT NULL
        `,
        [id, revisionString]
      );

      await client.query(
        'INSERT INTO audit_logs (action, page_id, details, ip, created_at) VALUES ($1, $2, $3, $4, $5)',
        [
          'page.revision.purge',
          id,
          JSON.stringify({ revision: revisionString, purgedAt }),
          ip,
          purgedAt
        ]
      );

      return {
        status: 'purged',
        revision: revisionString,
        purgedAt,
        scrubbedReceipts: scrubResult.rowCount
      };
    });
  }

  // Operation status lookup within one credential namespace (T08). A
  // read: it never passes the publishing gate, so an operation can be
  // confirmed while writes are paused for maintenance.
  async getOperation(actorNamespace, requestId) {
    const client = await this.pool.connect();

    try {
      return await findOperationRow(client, actorNamespace, requestId);
    } finally {
      client.release();
    }
  }

  // Owner confirmation by request identifier across namespaces (T08):
  // the dashboard reports the most recent operation recorded under the
  // identifier, whichever credential namespace committed it.
  async getOperationByRequestId(requestId) {
    const result = await this.pool.query(
      `
        SELECT actor_namespace, request_id, action, target_id, request_hmac,
          result_share_id, result_revision::text AS result_revision,
          result_access_revision::text AS result_access_revision,
          receipt_encrypted, result_state, created_at
        FROM public.publish_operations
        WHERE request_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [requestId]
    );

    return normalizeOperationRow(result.rows[0]);
  }

  async getById(id) {
    const result = await this.pool.query('SELECT * FROM pages WHERE id = $1 LIMIT 1', [id]);
    return result.rows[0] || null;
  }

  async getPublicById(id, now = Date.now()) {
    const result = await this.pool.query(
      `
        SELECT *, (expires_at IS NOT NULL AND expires_at <= $2) AS is_expired
        FROM pages
        WHERE id = $1
        LIMIT 1
      `,
      [id, now]
    );
    const row = result.rows[0];

    if (!row) {
      return null;
    }

    const page = { ...row };
    const isExpired = page.is_expired;
    delete page.is_expired;
    delete page.is_favorite;

    return {
      page,
      expired: Boolean(isExpired)
    };
  }

  async listRecent(limit = 10) {
    const result = await this.pool.query(
      `
        SELECT id, created_at, code_type, title, description, is_protected
        FROM pages
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [limit]
    );

    return result.rows;
  }

  async listAdminPages(options = {}) {
    const isUnpaginated = options.limit === null;
    const limit = Number.isInteger(options.limit) ? options.limit : 50;
    const offset = Number.isInteger(options.offset) ? options.offset : 0;
    const sortBy = options.sortBy || 'created_at';
    const sortOrder = options.sortOrder || 'desc';
    const { whereClause, params, nextParamIndex } = buildAdminPageFilter(options);

    const allowedSortColumns = { created_at: 'created_at', code_type: 'code_type', is_protected: 'is_protected' };
    const orderColumn = allowedSortColumns[sortBy] || 'created_at';
    const orderDirection = sortOrder === 'asc' ? 'ASC' : 'DESC';

    let paginationClause = '';

    if (!isUnpaginated) {
      params.push(limit, offset);
      paginationClause = `LIMIT $${nextParamIndex} OFFSET $${nextParamIndex + 1}`;
    }

    const result = await this.pool.query(
      `
        SELECT id, created_at, code_type, title, description, is_protected, is_favorite, encrypted_password, expires_at, COALESCE(view_count, 0) AS view_count, published, access_revision::text AS access_revision
        FROM pages
        ${whereClause}
        ORDER BY ${orderColumn} ${orderDirection}
        ${paginationClause}
      `,
      params
    );

    return result.rows;
  }

  async countPages(options = {}) {
    const { whereClause, params } = buildAdminPageFilter(options);

    const result = await this.pool.query(
      `SELECT COUNT(*) AS count FROM pages ${whereClause}`,
      params
    );
    return Number.parseInt(result.rows[0]?.count || '0', 10);
  }

  async recordViewEvent(id, now = Date.now(), hasAccess = false, accessRevision = null) {
    // A view event is a controlled write: while publishing writes are
    // paused it is not counted at all and reports 'maintenance' (T04).
    // Otherwise the success path is a single conditional UPDATE against
    // the current access policy (T01): a protected Share counts only when
    // the caller's credential revision still equals the stored
    // access_revision. No body content is read on this path.
    const revisionParam = accessRevision == null ? null : toAccessRevisionString(accessRevision);

    try {
      return await withPublishingWrite(this.pool, async (client) => {
        const updateResult = await client.query(
          `
            UPDATE pages
            SET view_count = COALESCE(view_count, 0) + 1
            WHERE id = $1
              AND published = TRUE
              AND (expires_at IS NULL OR expires_at > $2)
              AND (COALESCE(is_protected, 0) <> 1 OR ($3 AND access_revision = $4::bigint))
            RETURNING id
          `,
          [id, now, hasAccess, revisionParam]
        );

        if (updateResult.rowCount > 0) {
          return 'counted';
        }

        const stateResult = await client.query(
          'SELECT is_protected, expires_at, published FROM pages WHERE id = $1 LIMIT 1',
          [id]
        );
        const page = stateResult.rows[0];

        if (!page) {
          return 'not_found';
        }

        // An unpublished Share is indistinguishable from a missing one
        // on every public surface (T11), and that judgment outranks
        // expiry: unpublished + expired still reports 'not_found'.
        if (page.published === false) {
          return 'not_found';
        }

        if (page.expires_at !== null && Number(page.expires_at) <= now) {
          return 'expired';
        }

        return page.is_protected === 1 ? 'protected' : 'not_found';
      });
    } catch (error) {
      if (isPublishingPausedError(error)) {
        return 'maintenance';
      }

      throw error;
    }
  }

  async getAdminStats() {
    const now = Date.now();
    const since = managementRecentStart(14, now);
    const [summaryResult, typeResult, recentResult, topViewedResult] = await Promise.all([
      this.pool.query(`
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN is_protected = 1 THEN 1 ELSE 0 END), 0) AS protected,
          MAX(created_at) AS latest_created_at
        FROM pages
      `),
      this.pool.query(`
        SELECT COALESCE(code_type, 'html') AS code_type, COUNT(*) AS count
        FROM pages
        GROUP BY COALESCE(code_type, 'html')
        ORDER BY count DESC, code_type ASC
      `),
      this.pool.query(
        'SELECT created_at FROM pages WHERE created_at >= $1 ORDER BY created_at ASC',
        [since]
      ),
      this.pool.query(`
        SELECT id, title, COALESCE(view_count, 0) AS view_count
        FROM pages
        WHERE COALESCE(view_count, 0) > 0
        ORDER BY view_count DESC
        LIMIT 10
      `)
    ]);
    const summary = summaryResult.rows[0] || {};
    const total = Number.parseInt(summary.total || '0', 10);
    const protectedCount = Number.parseInt(summary.protected || '0', 10);

    return {
      total,
      protected: protectedCount,
      public: total - protectedCount,
      latestCreatedAt: summary.latest_created_at ? Number(summary.latest_created_at) : null,
      byType: typeResult.rows.map((row) => ({
        codeType: row.code_type || 'html',
        count: Number.parseInt(row.count || '0', 10)
      })),
      recentDays: buildManagementDailyStats(
        recentResult.rows.map((row) => Number(row.created_at)),
        14,
        now
      ),
      topViewed: topViewedResult.rows.map((row) => ({
        id: row.id,
        title: row.title || row.id,
        viewCount: Number.parseInt(row.view_count || '0', 10)
      }))
    };
  }

  async updateProtection(id, options) {
    const result = await withPublishingWrite(this.pool, client => client.query(
      `
        UPDATE pages
        SET is_protected = $1, password_hash = $2, encrypted_password = $3,
            access_revision = access_revision + 1
        WHERE id = $4
      `,
      [options.isProtected ? 1 : 0, options.passwordHash || null, options.encryptedPassword || null, id]
    ));

    return result.rowCount > 0;
  }

  // Conditional protection write used by the access-policy routes (T01).
  // The WHERE clause pins the expected revision, so the compare-and-swap and
  // the optional revision advance happen in one atomic UPDATE; two racing
  // writers cannot both succeed on the same expected revision.
  async updateProtectionWithAccessRevision(id, options, precondition = {}) {
    const expected = precondition.expectedAccessRevision == null
      ? null
      : toAccessRevisionString(precondition.expectedAccessRevision);

    return withPublishingWrite(this.pool, async (client) => {
      const result = await client.query(
        `
          UPDATE pages
          SET is_protected = $1, password_hash = $2, encrypted_password = $3,
              access_revision = CASE WHEN $4 THEN access_revision + 1 ELSE access_revision END
          WHERE id = $5
            AND ($6::bigint IS NULL OR access_revision = $6::bigint)
          RETURNING access_revision::text AS access_revision
        `,
        [
          options.isProtected ? 1 : 0,
          options.passwordHash || null,
          options.encryptedPassword || null,
          Boolean(precondition.advanceAccessRevision),
          id,
          expected
        ]
      );

      if (result.rowCount > 0) {
        return { status: 'updated', accessRevision: result.rows[0].access_revision };
      }

      return this.accessPreconditionMiss(id, client);
    });
  }

  // The one admin content/access write path (T01 + T06). The page row is
  // locked inside the publishing-gate transaction (the spec's lock order:
  // gate first, then the Share row), and two independent precondition
  // families are enforced in that same step; a combined save commits only
  // when both pass:
  //   - access family (T01): expectedAccessRevision compare-and-swap;
  //     advanceAccessRevision moves it when the policy actually changed.
  //   - content family (T06): expectedContentRevision compare-and-swap
  //     against current_revision. When the merged candidate snapshot
  //     differs byte-exactly from the current one, the materialized
  //     projection, the new current_revision, an immutable snapshot row
  //     and its audit record commit in this same transaction — any
  //     failure (including a COMMIT-time failure) rolls all of them
  //     back. An unchanged candidate writes no snapshot and reports
  //     contentChanged: false.
  // Callers that pass no content precondition (internal legacy writes)
  // still cannot bypass Revision: their content changes snapshot too.
  async updatePageWithPreconditions(id, options, precondition = {}) {
    return withPublishingWrite(
      this.pool,
      (client) => this.applyPageUpdate(client, id, options, precondition)
    );
  }

  // The transactional core of updatePageWithPreconditions, for callers
  // that already hold a publishing-write transaction (the idempotent
  // save/restore paths, T09). `lockedRow`, when supplied, is the pages
  // row the caller already selected FOR UPDATE in this transaction.
  // Two extra precondition markers serve the idempotent paths, where the
  // caller's precondition state is judged inside the transaction — after
  // an operation replay has had its chance: contentPreconditionMissing /
  // contentPreconditionInvalid for the content family and
  // accessPreconditionMissing for the access family.
  async applyPageUpdate(client, id, options, precondition = {}, lockedRow = null) {
    const expectedAccess = precondition.expectedAccessRevision == null
      ? null
      : toAccessRevisionString(precondition.expectedAccessRevision);
    const expectedContent = precondition.expectedContentRevision == null
      ? null
      : toContentRevisionString(precondition.expectedContentRevision);

    {
      let row = lockedRow;

      if (!row) {
        const selectResult = await client.query(
          'SELECT * FROM pages WHERE id = $1 FOR UPDATE',
          [id]
        );
        row = selectResult.rows[0];
      }

      if (!row) {
        return {
          status: 'not_found',
          accessRevision: null,
          contentRevision: null,
          contentChanged: false,
          current: null
        };
      }

      await ensureContentBaseline(client, row);

      const currentAccessRevision = toAccessRevisionString(row.access_revision);

      if (precondition.accessPreconditionMissing) {
        return {
          status: 'access_precondition_required',
          accessRevision: currentAccessRevision,
          contentRevision: toContentRevisionString(row.current_revision),
          contentChanged: false,
          current: null
        };
      }

      if (expectedAccess !== null && !accessRevisionMatches(currentAccessRevision, expectedAccess)) {
        return {
          status: 'conflict',
          accessRevision: currentAccessRevision,
          contentRevision: toContentRevisionString(row.current_revision),
          contentChanged: false,
          current: null
        };
      }

      const currentFields = rowContentFields(row);
      const candidate = {
        htmlContent: options.htmlContent !== undefined ? options.htmlContent : currentFields.htmlContent,
        codeType: currentFields.codeType,
        title: options.title !== undefined ? (options.title || null) : currentFields.title,
        description: options.description !== undefined ? (options.description || null) : currentFields.description,
        markdownTheme: options.markdownTheme !== undefined ? (options.markdownTheme || null) : currentFields.markdownTheme
      };
      const currentContentRevision = toContentRevisionString(row.current_revision);

      if (precondition.contentPreconditionMissing) {
        return {
          status: 'precondition_required',
          accessRevision: currentAccessRevision,
          contentRevision: currentContentRevision,
          contentChanged: false,
          current: { ...currentFields }
        };
      }

      if (precondition.contentPreconditionInvalid) {
        return {
          status: 'content_conflict',
          accessRevision: currentAccessRevision,
          contentRevision: currentContentRevision,
          contentChanged: false,
          current: { ...currentFields }
        };
      }

      if (expectedContent !== null && !contentRevisionMatches(currentContentRevision, expectedContent)) {
        return {
          status: 'content_conflict',
          accessRevision: currentAccessRevision,
          contentRevision: currentContentRevision,
          contentChanged: false,
          current: { ...currentFields }
        };
      }

      const contentChanged = !contentSnapshotsEqual(candidate, currentFields);
      const sets = [];
      const params = [];
      let paramIndex = 1;

      if (options.expiresAt !== undefined) {
        sets.push(`expires_at = $${paramIndex}`);
        params.push(options.expiresAt || null);
        paramIndex += 1;
      }

      if (options.isProtected !== undefined) {
        sets.push(`is_protected = $${paramIndex}`);
        params.push(options.isProtected ? 1 : 0);
        paramIndex += 1;
        sets.push(`password_hash = $${paramIndex}`);
        params.push(options.passwordHash || null);
        paramIndex += 1;
        sets.push(`encrypted_password = $${paramIndex}`);
        params.push(options.encryptedPassword || null);
        paramIndex += 1;
      }

      let nextRevision = currentContentRevision;

      if (contentChanged) {
        nextRevision = nextContentRevision(currentContentRevision);
        sets.push(`html_content = $${paramIndex}`);
        params.push(candidate.htmlContent);
        paramIndex += 1;
        sets.push(`title = $${paramIndex}`);
        params.push(candidate.title);
        paramIndex += 1;
        sets.push(`description = $${paramIndex}`);
        params.push(candidate.description);
        paramIndex += 1;
        sets.push(`markdown_theme = $${paramIndex}`);
        params.push(candidate.markdownTheme);
        paramIndex += 1;
        sets.push(`current_revision = $${paramIndex}::bigint`);
        params.push(nextRevision);
        paramIndex += 1;
      }

      if (precondition.advanceAccessRevision) {
        sets.push('access_revision = access_revision + 1');
      }

      if (sets.length > 0) {
        params.push(id);
        await client.query(
          `UPDATE pages SET ${sets.join(', ')} WHERE id = $${paramIndex}`,
          params
        );
      }

      if (contentChanged) {
        const updatedRow = {
          ...row,
          html_content: candidate.htmlContent,
          title: candidate.title,
          description: candidate.description,
          markdown_theme: candidate.markdownTheme
        };
        await insertContentSnapshotRow(
          client,
          updatedRow,
          nextRevision,
          precondition.contentMeta || {}
        );
        await client.query(
          'INSERT INTO audit_logs (action, page_id, details, ip, created_at) VALUES ($1, $2, $3, $4, $5)',
          [
            'page.content.update',
            id,
            JSON.stringify({
              fromRevision: currentContentRevision,
              toRevision: nextRevision,
              source: (precondition.contentMeta || {}).source || 'admin-edit',
              ...((precondition.contentMeta || {}).restoredFromRevision != null
                ? { restoredFromRevision: (precondition.contentMeta || {}).restoredFromRevision }
                : {})
            }),
            precondition.ip || null,
            Date.now()
          ]
        );
      }

      return {
        status: 'updated',
        accessRevision: precondition.advanceAccessRevision
          ? nextAccessRevision(currentAccessRevision)
          : currentAccessRevision,
        contentRevision: nextRevision,
        contentChanged,
        current: null
      };
    }
  }

  // Admin save that may combine content fields with access-policy fields
  // (T01). Kept for the pre-T06 call shape; it delegates to the unified
  // path so its content changes also produce Revisions (no bypass).
  async updatePageWithAccessPolicy(id, options, precondition = {}) {
    const result = await this.updatePageWithPreconditions(id, options, {
      ...precondition,
      expectedContentRevision: null,
      contentMeta: { source: 'admin-edit', actorType: 'owner' }
    });

    return { status: result.status, accessRevision: result.accessRevision };
  }

  // Explicit admin revocation entry (T01): advances the access revision
  // without touching the password, expiry, or content.
  async revokeAccess(id, expectedAccessRevision) {
    const expected = expectedAccessRevision == null
      ? null
      : toAccessRevisionString(expectedAccessRevision);

    return withPublishingWrite(this.pool, async (client) => {
      const result = await client.query(
        `
          UPDATE pages
          SET access_revision = access_revision + 1
          WHERE id = $1
            AND ($2::bigint IS NULL OR access_revision = $2::bigint)
          RETURNING access_revision::text AS access_revision
        `,
        [id, expected]
      );

      if (result.rowCount > 0) {
        return { status: 'updated', accessRevision: result.rows[0].access_revision };
      }

      return this.accessPreconditionMiss(id, client);
    });
  }

  async accessPreconditionMiss(id, client = this.pool) {
    const result = await client.query(
      'SELECT access_revision::text AS access_revision FROM pages WHERE id = $1 LIMIT 1',
      [id]
    );
    const row = result.rows[0];

    if (!row) {
      return { status: 'not_found', accessRevision: null };
    }

    return { status: 'conflict', accessRevision: row.access_revision };
  }

  async setFavorite(id, isFavorite) {
    if (typeof isFavorite !== 'boolean') {
      throw new TypeError('isFavorite must be a boolean');
    }

    const result = await withPublishingWrite(this.pool, client => client.query(
      `
        WITH existing AS MATERIALIZED (
          SELECT id, is_favorite
          FROM pages
          WHERE id = $1
          FOR UPDATE
        ), updated AS (
          UPDATE pages
          SET is_favorite = $2
          FROM existing
          WHERE pages.id = existing.id
            AND existing.is_favorite IS DISTINCT FROM $2
          RETURNING pages.is_favorite
        )
        SELECT
          EXISTS(SELECT 1 FROM existing) AS found,
          EXISTS(SELECT 1 FROM updated) AS changed,
          COALESCE(
            (SELECT is_favorite FROM updated),
            (SELECT is_favorite FROM existing),
            FALSE
          ) AS is_favorite,
          (SELECT is_favorite FROM existing) AS previous_value
      `,
      [id, isFavorite]
    ));
    const row = result.rows[0];

    return {
      found: row.found,
      changed: row.changed,
      isFavorite: row.is_favorite,
      previousValue: row.previous_value
    };
  }

  // Legacy unconditional write entry. It delegates to the unified path
  // (T06) so even a caller without preconditions cannot change content
  // without producing a Revision snapshot.
  async updatePage(id, options) {
    const { fields } = buildPageUpdateFields(options);

    if (fields.length === 0) {
      return true;
    }

    const result = await this.updatePageWithPreconditions(id, options, {
      contentMeta: { source: 'legacy-update', actorType: 'owner' }
    });
    return result.status === 'updated';
  }

  async getContentSnapshot(id, revision) {
    const revisionString = toContentRevisionString(revision);

    if (revisionString === null) {
      return null;
    }

    const result = await this.pool.query(
      `
        SELECT share_id, revision::text AS revision, html_content, code_type,
               title, description, markdown_theme, snapshot_hash, source,
               actor_type, actor_id, restored_from_revision::text AS restored_from_revision,
               created_at, purged_at
        FROM share_revisions
        WHERE share_id = $1 AND revision = $2::bigint
        LIMIT 1
      `,
      [id, revisionString]
    );

    return result.rows[0] || null;
  }

  async listContentSnapshots(id) {
    const result = await this.pool.query(
      `
        SELECT share_id, revision::text AS revision, html_content, code_type,
               title, description, markdown_theme, snapshot_hash, source,
               actor_type, actor_id, restored_from_revision::text AS restored_from_revision,
               created_at, purged_at
        FROM share_revisions
        WHERE share_id = $1
        ORDER BY share_revisions.revision ASC
      `,
      [id]
    );

    return result.rows;
  }

  // Paginated history metadata for the admin history browser (T07,
  // issue #31). Newest Revision first; the query deliberately never
  // selects html_content, so listing history cannot become an unbounded
  // content aggregation. Revision numbers are cast to text in SQL and
  // stay decimal strings end to end (no BIGINT rounding in JS).
  async listContentRevisionMeta(id, { limit = 20, offset = 0 } = {}) {
    const countResult = await this.pool.query(
      'SELECT COUNT(*)::int AS total FROM share_revisions WHERE share_id = $1',
      [id]
    );
    const result = await this.pool.query(
      `
        SELECT revision::text AS revision, created_at, source, actor_type,
               restored_from_revision::text AS restored_from_revision,
               purged_at
        FROM share_revisions
        WHERE share_id = $1
        ORDER BY share_revisions.revision DESC
        LIMIT $2 OFFSET $3
      `,
      [id, limit, offset]
    );

    return { total: countResult.rows[0].total, revisions: result.rows };
  }

  // The baseline DML of the parent spec's rollout (issue #24 §11 step 4)
  // as a repository operation: every Share without a baseline gains
  // Revision 1 capturing its current fields, with the capture time of
  // THIS run. A second run skips everything. The operator script
  // (scripts/backfill-revision-baseline.js) wraps this with the required
  // paused-and-drained window enforcement; this method only performs the
  // DML inside one gated transaction.
  async backfillRevisionBaselines({ now = Date.now() } = {}) {
    return withPublishingWrite(this.pool, async (client) => {
      const result = await client.query(
        'SELECT * FROM pages WHERE current_revision IS NULL ORDER BY id FOR UPDATE'
      );
      let baselined = 0;

      for (const row of result.rows) {
        if (await ensureContentBaseline(client, row, now)) {
          baselined += 1;
        }
      }

      const countResult = await client.query(
        'SELECT COUNT(*)::int AS count FROM pages WHERE current_revision IS NOT NULL'
      );

      return { baselined, skipped: countResult.rows[0].count };
    });
  }

  async deletePage(id) {
    const result = await withPublishingWrite(this.pool, async (client) => {
      // Full deletion clears the Share's grants in the same transaction
      // (T12, parent spec #24 §3): no authorization may outlive the
      // resource it names. Lock the Share row first — the lock every
      // grant write takes after the Key row — so a concurrently
      // committing grant is either already visible (and removed below)
      // or waits and then finds the Share gone.
      await client.query('SELECT id FROM pages WHERE id = $1 FOR UPDATE', [id]);
      await client.query('DELETE FROM public.share_grants WHERE share_id = $1', [id]);
      const deleted = await client.query('DELETE FROM pages WHERE id = $1', [id]);

      // Full deletion retires any publish-operation result pointing at
      // the Share in the same transaction (T08): the record stays as a
      // content-free dedup tombstone — receipt cleared, result marked
      // unavailable — so a late retry of the original create can neither
      // resurrect the Share nor mint a replacement under the old
      // identifier.
      await client.query(
        `
          UPDATE public.publish_operations
          SET receipt_encrypted = NULL, result_state = 'result_unavailable'
          WHERE result_share_id = $1 AND result_state = 'committed'
        `,
        [id]
      );

      return deleted;
    });
    return result.rowCount > 0;
  }

  async deletePages(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    const result = await withPublishingWrite(this.pool, async (client) => {
      // Lock every target Share row in ID order before cleaning up
      // grants, mirroring deletePage's single-Share ordering.
      await client.query(
        'SELECT id FROM pages WHERE id = ANY($1) ORDER BY id FOR UPDATE',
        [ids]
      );
      await client.query(
        'DELETE FROM public.share_grants WHERE share_id = ANY($1)',
        [ids]
      );
      const deleted = await client.query(
        'DELETE FROM pages WHERE id = ANY($1)',
        [ids]
      );
      await client.query(
        `
          UPDATE public.publish_operations
          SET receipt_encrypted = NULL, result_state = 'result_unavailable'
          WHERE result_share_id = ANY($1) AND result_state = 'committed'
        `,
        [ids]
      );

      return deleted;
    });
    return result.rowCount;
  }

  async createApiKey(apiKey) {
    const result = await withPublishingWrite(this.pool, client => client.query(
      `
        INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at, credential_version, scopes, auto_grant_new_share_edit)
        VALUES ($1, $2, $3, $4, $5, 1, $6, $7)
        RETURNING id, name, key_prefix, created_at, last_used_at, credential_version::text AS credential_version, scopes, auto_grant_new_share_edit
      `,
      [
        apiKey.id,
        apiKey.name,
        apiKey.keyHash,
        apiKey.keyPrefix,
        apiKey.createdAt,
        serializeApiKeyScopes(apiKey.scopes),
        apiKey.autoGrantNewShareEdit === true
      ]
    ));

    return result.rows[0];
  }

  async listApiKeys() {
    const result = await this.pool.query(
      `
        SELECT id, name, key_prefix, created_at, last_used_at, credential_version::text AS credential_version, scopes, auto_grant_new_share_edit
        FROM api_keys
        ORDER BY created_at DESC
      `
    );

    return result.rows;
  }

  async getApiKeyById(id) {
    const result = await this.pool.query(
      'SELECT id, name, key_hash, key_prefix, created_at, last_used_at, credential_version::text AS credential_version, scopes, auto_grant_new_share_edit FROM api_keys WHERE id = $1 LIMIT 1',
      [id]
    );

    return result.rows[0] || null;
  }

  // Scope assignment (T12): replaces the Key's stored scope list in one
  // gated write. Scopes are owner-managed credential metadata — changing
  // them never touches any Share, and the change takes effect for the
  // next request that verifies the Key (each request re-reads the row
  // at authentication). Returns the public record, or null when the Key
  // does not exist.
  async updateApiKeyScopes(id, scopes) {
    const result = await withPublishingWrite(this.pool, client => client.query(
      `
        UPDATE api_keys
        SET scopes = $2
        WHERE id = $1
        RETURNING id, name, key_prefix, created_at, last_used_at, credential_version::text AS credential_version, scopes, auto_grant_new_share_edit
      `,
      [id, serializeApiKeyScopes(scopes)]
    ));

    return result.rows[0] || null;
  }

  // Auto-edit opt-in (T13): flips auto_grant_new_share_edit in one
  // gated write. The flag is read inside the create transaction under
  // the Key row lock (see insertAutoEditGrants), so toggling it can
  // never interleave with a create it should or should not cover: the
  // toggle either commits before the create's lock (and applies) or
  // waits behind it (and does not). Returns the public record, or null
  // when the Key does not exist.
  async updateApiKeyAutoGrant(id, enabled) {
    const result = await withPublishingWrite(this.pool, client => client.query(
      `
        UPDATE api_keys
        SET auto_grant_new_share_edit = $2
        WHERE id = $1
        RETURNING id, name, key_prefix, created_at, last_used_at, credential_version::text AS credential_version, scopes, auto_grant_new_share_edit
      `,
      [id, enabled === true]
    ));

    return result.rows[0] || null;
  }

  // Rotation (T05): a single gated UPDATE keeps the logical Key ID, name
  // and creation time, replaces the secret hash/prefix and advances the
  // credential version atomically. The row lock taken by the UPDATE waits
  // for any in-flight API write that locked the Key row first (and vice
  // versa), so the version advance and the invalidation of the old secret
  // are one indivisible step. Returns the public record (never the hash),
  // or null when the Key does not exist. Scopes and Share grants (T12)
  // belong to the logical Key, not to the secret: both survive rotation
  // untouched.
  async rotateApiKey(id, { keyHash, keyPrefix } = {}) {
    const result = await withPublishingWrite(this.pool, client => client.query(
      `
        UPDATE api_keys
        SET key_hash = $2, key_prefix = $3, credential_version = credential_version + 1
        WHERE id = $1
        RETURNING id, name, key_prefix, created_at, last_used_at, credential_version::text AS credential_version, scopes, auto_grant_new_share_edit
      `,
      [id, keyHash, keyPrefix]
    ));

    return result.rows[0] || null;
  }

  async deleteApiKey(id) {
    const result = await withPublishingWrite(this.pool, async (client) => {
      // Deleting a Key retires every grant it held in the same
      // transaction (T12): a deleted credential must leave no
      // authorization behind. The Key row is locked FIRST — the same
      // lock grant/revoke take before touching grants — so a grant
      // that is committing concurrently either lands before this lock
      // (and is deleted below) or waits behind it (and then finds the
      // Key gone). Cleaning up before the lock would leave exactly
      // the orphan this ordering prevents.
      await client.query('SELECT id FROM api_keys WHERE id = $1 FOR UPDATE', [id]);
      await client.query('DELETE FROM public.share_grants WHERE api_key_id = $1', [id]);
      return client.query('DELETE FROM api_keys WHERE id = $1', [id]);
    });
    return result.rowCount > 0;
  }

  // --- Per-Share grants (T12, issue #36) ----------------------------------
  //
  // Grant and revoke are publishing writes: they pass the T04 gate and
  // follow the parent spec's fixed lock order — the managed Key row
  // first, then the Share row — the same order the credential re-check
  // (T05) uses, so a grant change can never interleave with a rotation
  // or a Share write in the opposite order. Grants are keyed by the
  // LOGICAL Key ID, so they survive rotation; they are removed in the
  // same transaction when the Key or the Share is deleted.

  async grantShareAccess({ keyId, shareId, permissions, now = Date.now() }) {
    return withPublishingWrite(this.pool, async (client) => {
      const keyResult = await client.query(
        'SELECT id FROM api_keys WHERE id = $1 FOR UPDATE',
        [keyId]
      );

      if (keyResult.rows.length === 0) {
        return { status: 'key_not_found' };
      }

      const shareResult = await client.query(
        'SELECT id FROM pages WHERE id = $1 FOR UPDATE',
        [shareId]
      );

      if (shareResult.rows.length === 0) {
        return { status: 'share_not_found' };
      }

      const existing = await client.query(
        'SELECT api_key_id FROM public.share_grants WHERE api_key_id = $1 AND share_id = $2',
        [keyId, shareId]
      );
      const created = existing.rows.length === 0;

      const result = await client.query(
        `
          INSERT INTO public.share_grants (
            api_key_id, share_id, can_read, can_update, can_publish, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $6)
          ON CONFLICT (api_key_id, share_id) DO UPDATE
          SET can_read = EXCLUDED.can_read,
              can_update = EXCLUDED.can_update,
              can_publish = EXCLUDED.can_publish,
              updated_at = EXCLUDED.updated_at
          RETURNING api_key_id, share_id, can_read, can_update, can_publish, created_at, updated_at
        `,
        [keyId, shareId, permissions.read, permissions.update, permissions.publish, now]
      );

      return { status: 'ok', created, grant: normalizeGrantRow(result.rows[0]) };
    });
  }

  async revokeShareAccess({ keyId, shareId }) {
    return withPublishingWrite(this.pool, async (client) => {
      const keyResult = await client.query(
        'SELECT id FROM api_keys WHERE id = $1 FOR UPDATE',
        [keyId]
      );

      if (keyResult.rows.length === 0) {
        return { status: 'key_not_found' };
      }

      // Same Key-then-Share lock order as grant. A grant whose Share
      // was deleted out from under it (only possible outside the app's
      // own delete path, which cleans grants up) can still be revoked:
      // the lock is taken when the Share exists, the delete runs
      // either way.
      await client.query('SELECT id FROM pages WHERE id = $1 FOR UPDATE', [shareId]);

      const result = await client.query(
        'DELETE FROM public.share_grants WHERE api_key_id = $1 AND share_id = $2',
        [keyId, shareId]
      );

      if (result.rowCount === 0) {
        return { status: 'grant_not_found' };
      }

      return { status: 'ok' };
    });
  }

  // The owner's view of one Key's grants (admin grant panel). Includes
  // the Share title for display — this is the owner's own dashboard,
  // not an API response — and whether the Share still exists.
  async listShareGrants(keyId) {
    const result = await this.pool.query(
      `
        SELECT g.api_key_id, g.share_id, g.can_read, g.can_update, g.can_publish,
               g.created_at, g.updated_at,
               (p.id IS NOT NULL) AS share_exists, p.title AS share_title
        FROM public.share_grants g
        LEFT JOIN public.pages p ON p.id = g.share_id
        WHERE g.api_key_id = $1
        ORDER BY g.created_at ASC, g.share_id ASC
      `,
      [keyId]
    );

    return result.rows.map(row => ({
      ...normalizeGrantRow(row),
      shareExists: row.share_exists === true,
      shareTitle: row.share_title ?? null
    }));
  }

  async getShareGrant(keyId, shareId) {
    const result = await this.pool.query(
      `
        SELECT api_key_id, share_id, can_read, can_update, can_publish, created_at, updated_at
        FROM public.share_grants
        WHERE api_key_id = $1 AND share_id = $2
        LIMIT 1
      `,
      [keyId, shareId]
    );

    return result.rows[0] ? normalizeGrantRow(result.rows[0]) : null;
  }

  // The granted-Share list for the v1 API: only Shares this Key holds a
  // grant on, in the stable (created_at, id) order, keyset-paginated by
  // the same tuple so the ORDER BY and the cursor filter express ONE
  // comparison and cannot disagree. The query never selects password
  // material, the favorite flag or view counts — the list cannot leak
  // what its projection does not fetch. Title/description are returned
  // verbatim; the route neutralizes them for grants without read.
  async listGrantedShares({ keyId, limit = 20, cursor = null } = {}) {
    const params = [keyId];
    let cursorClause = '';

    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      cursorClause = `AND (p.created_at, p.id) > ($${params.length - 1}, $${params.length})`;
    }

    params.push(limit + 1);
    const result = await this.pool.query(
      `
        SELECT p.id, p.code_type, p.title, p.description, p.markdown_theme,
               p.created_at, p.expires_at, p.is_protected, p.published,
               p.current_revision::text AS current_revision,
               p.access_revision::text AS access_revision,
               g.can_read, g.can_update, g.can_publish
        FROM public.share_grants g
        JOIN public.pages p ON p.id = g.share_id
        WHERE g.api_key_id = $1 ${cursorClause}
        ORDER BY p.created_at ASC, p.id ASC
        LIMIT $${params.length}
      `,
      params
    );

    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const last = rows[rows.length - 1];

    return {
      shares: rows.map(row => ({
        id: row.id,
        codeType: row.code_type || 'html',
        title: row.title ?? null,
        description: row.description ?? null,
        markdownTheme: row.markdown_theme ?? null,
        createdAt: Number(row.created_at),
        expiresAt: row.expires_at === null || row.expires_at === undefined
          ? null
          : Number(row.expires_at),
        isProtected: Number(row.is_protected) === 1,
        published: row.published !== false,
        contentRevision: row.current_revision === null || row.current_revision === undefined
          ? null
          : String(row.current_revision),
        accessRevision: toAccessRevisionString(row.access_revision),
        permissions: grantPermissionsFromRow(row)
      })),
      nextPosition: hasMore && last
        ? { createdAt: Number(last.created_at), id: last.id }
        : null
    };
  }

  // Content read for the v1 API (T12): the grant, the Share's current
  // materialized fields and its current Revision snapshot in one read.
  // Returns null when the Key holds no grant on the Share (or the Share
  // is gone) — the route answers the same 404 either way, so existence
  // is never probed through this surface. Deliberately NOT judged by
  // public visibility: published/expiry/protection are public-surface
  // concepts; a granted manager reads an unpublished or expired Share
  // exactly like the owner does in the admin.
  async getGrantedShareContent({ keyId, shareId }) {
    const result = await this.pool.query(
      `
        SELECT g.can_read, g.can_update, g.can_publish,
               p.id, p.html_content, p.code_type, p.title, p.description, p.markdown_theme,
               p.current_revision::text AS current_revision,
               s.share_id AS snapshot_share_id,
               s.html_content AS snapshot_html_content,
               s.code_type AS snapshot_code_type,
               s.title AS snapshot_title,
               s.description AS snapshot_description,
               s.markdown_theme AS snapshot_markdown_theme,
               s.purged_at AS snapshot_purged_at
        FROM public.share_grants g
        JOIN public.pages p ON p.id = g.share_id
        LEFT JOIN public.share_revisions s
          ON s.share_id = p.id AND s.revision = p.current_revision
        WHERE g.api_key_id = $1 AND g.share_id = $2
        LIMIT 1
      `,
      [keyId, shareId]
    );

    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return {
      permissions: grantPermissionsFromRow(row),
      shareId: row.id,
      currentRevision: row.current_revision === null || row.current_revision === undefined
        ? null
        : String(row.current_revision),
      // The Share's materialized current fields (parent spec #24 §3:
      // the projection OF the current Revision). Used only when no
      // snapshot row exists — a Share that predates its baseline.
      live: {
        htmlContent: row.html_content,
        codeType: row.code_type || 'html',
        title: row.title ?? null,
        description: row.description ?? null,
        markdownTheme: row.markdown_theme ?? null
      },
      snapshot: row.snapshot_share_id === null || row.snapshot_share_id === undefined
        ? null
        : {
            htmlContent: row.snapshot_html_content,
            codeType: row.snapshot_code_type || 'html',
            title: row.snapshot_title ?? null,
            description: row.snapshot_description ?? null,
            markdownTheme: row.snapshot_markdown_theme ?? null,
            purgedAt: row.snapshot_purged_at ?? null
          }
    };
  }

  // State read for the v1 API (T12): ONLY the restricted state fields
  // the access ETag covers. The query never selects the title,
  // description or body, so this surface cannot leak them by accident.
  async getGrantedShareState({ keyId, shareId }) {
    const result = await this.pool.query(
      `
        SELECT g.can_read, g.can_update, g.can_publish,
               p.id, p.published, p.is_protected, p.expires_at,
               p.access_revision::text AS access_revision
        FROM public.share_grants g
        JOIN public.pages p ON p.id = g.share_id
        WHERE g.api_key_id = $1 AND g.share_id = $2
        LIMIT 1
      `,
      [keyId, shareId]
    );

    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return {
      permissions: grantPermissionsFromRow(row),
      share: {
        id: row.id,
        published: row.published !== false,
        isProtected: Number(row.is_protected) === 1,
        expiresAt: row.expires_at === null || row.expires_at === undefined
          ? null
          : Number(row.expires_at),
        accessRevision: toAccessRevisionString(row.access_revision)
      }
    };
  }

  // Granted history list for the v1 API (T14, issue #38): the Revision
  // metadata of one granted Share, newest first, paginated exactly like
  // the dashboard history browser. Grant, Share pointer, total and the
  // metadata page are read by ONE statement, so they all come from a
  // single snapshot: the currentRevision the route derives each entry's
  // `current` flag from can never be a stale pointer contradicting the
  // rows it accompanies (the failure mode of reading the page row and
  // the Revision rows in separate queries while a concurrent edit
  // commits in between). The query deliberately never selects
  // html_content, so listing history cannot become an unbounded content
  // aggregation. Returns null when the Key holds no grant on the Share
  // (or the Share is gone) — the route answers the same 404 either way.
  // Deliberately NOT judged by public visibility: a granted manager
  // reads the history of an unpublished or expired Share exactly like
  // the owner does in the admin.
  async getGrantedShareRevisions({ keyId, shareId, limit = 20, offset = 0 }) {
    const result = await this.pool.query(
      `
        SELECT g.can_read, g.can_update, g.can_publish,
               p.current_revision::text AS current_revision,
               COUNT(r.revision) OVER ()::int AS total,
               r.revision::text AS revision, r.created_at, r.source,
               r.actor_type,
               r.restored_from_revision::text AS restored_from_revision,
               r.purged_at
        FROM public.share_grants g
        JOIN public.pages p ON p.id = g.share_id
        LEFT JOIN public.share_revisions r ON r.share_id = p.id
        WHERE g.api_key_id = $1 AND g.share_id = $2
        ORDER BY r.revision DESC NULLS LAST
        LIMIT $3 OFFSET $4
      `,
      [keyId, shareId, limit, offset]
    );

    const first = result.rows[0];

    if (!first) {
      // An out-of-range page of a granted Share is an empty list, not a
      // missing Share: distinguish the two with an existence read (it
      // carries no Revision rows, so there is nothing for its pointer
      // to contradict).
      const existence = await this.pool.query(
        `
          SELECT g.can_read, g.can_update, g.can_publish,
                 p.current_revision::text AS current_revision,
                 (SELECT COUNT(*)::int FROM public.share_revisions c
                   WHERE c.share_id = p.id) AS total
          FROM public.share_grants g
          JOIN public.pages p ON p.id = g.share_id
          WHERE g.api_key_id = $1 AND g.share_id = $2
          LIMIT 1
        `,
        [keyId, shareId]
      );
      const existing = existence.rows[0];

      if (!existing) {
        return null;
      }

      return {
        permissions: grantPermissionsFromRow(existing),
        shareId,
        currentRevision: existing.current_revision === null || existing.current_revision === undefined
          ? null
          : String(existing.current_revision),
        total: Number(existing.total),
        revisions: []
      };
    }

    return {
      permissions: grantPermissionsFromRow(first),
      shareId,
      currentRevision: first.current_revision === null || first.current_revision === undefined
        ? null
        : String(first.current_revision),
      total: Number(first.total),
      revisions: result.rows
        .filter(row => row.revision !== null)
        .map(row => ({
          revision: row.revision,
          created_at: row.created_at,
          source: row.source,
          actor_type: row.actor_type,
          restored_from_revision: row.restored_from_revision ?? null,
          purged_at: row.purged_at ?? null
        }))
    };
  }

  // Granted single-Revision read for the v1 API (T14): one complete
  // snapshot of one granted Share. Grant, the Share's current pointer
  // and the snapshot row are read by ONE statement (one snapshot), so
  // the `current` flag the route derives is coherent with the snapshot
  // it accompanies. Returns null when the Key holds no grant (or the
  // Share is gone); `snapshot` is null when the Revision does not
  // exist. A purged Revision returns its tombstone row (payload columns
  // already null) — the route answers 410, never a fabricated snapshot.
  async getGrantedShareRevision({ keyId, shareId, revision }) {
    const revisionString = toContentRevisionString(revision);

    if (revisionString === null) {
      return null;
    }

    const result = await this.pool.query(
      `
        SELECT g.can_read, g.can_update, g.can_publish,
               p.current_revision::text AS current_revision,
               r.share_id AS snapshot_share_id,
               r.revision::text AS revision, r.html_content, r.code_type,
               r.title, r.description, r.markdown_theme, r.snapshot_hash,
               r.source, r.actor_type, r.actor_id,
               r.restored_from_revision::text AS restored_from_revision,
               r.created_at, r.purged_at
        FROM public.share_grants g
        JOIN public.pages p ON p.id = g.share_id
        LEFT JOIN public.share_revisions r
          ON r.share_id = p.id AND r.revision = $3::bigint
        WHERE g.api_key_id = $1 AND g.share_id = $2
        LIMIT 1
      `,
      [keyId, shareId, revisionString]
    );

    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return {
      permissions: grantPermissionsFromRow(row),
      shareId,
      currentRevision: row.current_revision === null || row.current_revision === undefined
        ? null
        : String(row.current_revision),
      snapshot: row.snapshot_share_id === null || row.snapshot_share_id === undefined
        ? null
        : {
            share_id: row.snapshot_share_id,
            revision: row.revision,
            html_content: row.html_content,
            code_type: row.code_type,
            title: row.title,
            description: row.description,
            markdown_theme: row.markdown_theme,
            snapshot_hash: row.snapshot_hash,
            source: row.source,
            actor_type: row.actor_type,
            actor_id: row.actor_id,
            restored_from_revision: row.restored_from_revision,
            created_at: row.created_at,
            purged_at: row.purged_at
          }
    };
  }

  // Deliberately NOT gated (T04): the last-used timestamp is background
  // bookkeeping for an already-authorized read and must never block or be
  // blocked by read access during a maintenance window.
  async touchApiKey(id, usedAt = Date.now()) {
    await this.pool.query('UPDATE api_keys SET last_used_at = $2 WHERE id = $1', [id, usedAt]);
  }

  async createAuditLog({ action, pageId, details, ip }) {
    await this.pool.query(
      'INSERT INTO audit_logs (action, page_id, details, ip, created_at) VALUES ($1, $2, $3, $4, $5)',
      [action, pageId || null, details || null, ip || null, Date.now()]
    );
  }

  async listAuditLogs(options = {}) {
    const limit = Math.min(options.limit || 50, 200);
    const offset = options.offset || 0;
    const result = await this.pool.query(
      'SELECT id, action, page_id, details, ip, created_at FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    return result.rows.map((row) => ({
      id: row.id,
      action: row.action,
      pageId: row.page_id,
      details: row.details,
      ip: row.ip,
      createdAt: Number(row.created_at)
    }));
  }

  async countAuditLogs() {
    const result = await this.pool.query('SELECT COUNT(*) AS count FROM audit_logs');
    return Number.parseInt(result.rows[0]?.count || '0', 10);
  }
}

module.exports = {
  PostgresPageRepository
};
