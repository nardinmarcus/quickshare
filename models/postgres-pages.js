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
  credentialVersionMatches
} = require('../utils/apiKeyIdentity');
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
// snapshot still exists. The receipt is only honored as far as this
// current state allows — a changed access policy never gets the old
// password back.
async function loadResultShareState(client, operation) {
  const result = await client.query(
    `
      SELECT p.access_revision::text AS access_revision, p.is_protected,
        EXISTS (
          SELECT 1 FROM public.share_revisions r
          WHERE r.share_id = p.id AND r.revision = $2::bigint
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
        SELECT id, created_at, code_type, title, description, is_protected, is_favorite, encrypted_password, expires_at, COALESCE(view_count, 0) AS view_count
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
          'SELECT is_protected, expires_at FROM pages WHERE id = $1 LIMIT 1',
          [id]
        );
        const page = stateResult.rows[0];

        if (!page) {
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
    const expectedAccess = precondition.expectedAccessRevision == null
      ? null
      : toAccessRevisionString(precondition.expectedAccessRevision);
    const expectedContent = precondition.expectedContentRevision == null
      ? null
      : toContentRevisionString(precondition.expectedContentRevision);

    return withPublishingWrite(this.pool, async (client) => {
      const selectResult = await client.query(
        'SELECT * FROM pages WHERE id = $1 FOR UPDATE',
        [id]
      );
      const row = selectResult.rows[0];

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
              source: (precondition.contentMeta || {}).source || 'admin-edit'
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
    });
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
               created_at
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
               created_at
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
               restored_from_revision::text AS restored_from_revision
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
        INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at, credential_version)
        VALUES ($1, $2, $3, $4, $5, 1)
        RETURNING id, name, key_prefix, created_at, last_used_at, credential_version::text AS credential_version
      `,
      [apiKey.id, apiKey.name, apiKey.keyHash, apiKey.keyPrefix, apiKey.createdAt]
    ));

    return result.rows[0];
  }

  async listApiKeys() {
    const result = await this.pool.query(
      `
        SELECT id, name, key_prefix, created_at, last_used_at, credential_version::text AS credential_version
        FROM api_keys
        ORDER BY created_at DESC
      `
    );

    return result.rows;
  }

  async getApiKeyById(id) {
    const result = await this.pool.query(
      'SELECT id, name, key_hash, key_prefix, created_at, last_used_at, credential_version::text AS credential_version FROM api_keys WHERE id = $1 LIMIT 1',
      [id]
    );

    return result.rows[0] || null;
  }

  // Rotation (T05): a single gated UPDATE keeps the logical Key ID, name
  // and creation time, replaces the secret hash/prefix and advances the
  // credential version atomically. The row lock taken by the UPDATE waits
  // for any in-flight API write that locked the Key row first (and vice
  // versa), so the version advance and the invalidation of the old secret
  // are one indivisible step. Returns the public record (never the hash),
  // or null when the Key does not exist.
  async rotateApiKey(id, { keyHash, keyPrefix } = {}) {
    const result = await withPublishingWrite(this.pool, client => client.query(
      `
        UPDATE api_keys
        SET key_hash = $2, key_prefix = $3, credential_version = credential_version + 1
        WHERE id = $1
        RETURNING id, name, key_prefix, created_at, last_used_at, credential_version::text AS credential_version
      `,
      [id, keyHash, keyPrefix]
    ));

    return result.rows[0] || null;
  }

  async deleteApiKey(id) {
    const result = await withPublishingWrite(this.pool, client => client.query(
      'DELETE FROM api_keys WHERE id = $1',
      [id]
    ));
    return result.rowCount > 0;
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
