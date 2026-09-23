const { invalidApiKey } = require('../utils/apiKeyIdentity');
const { createPostgresPool } = require('./postgres-config');
const { maintenanceError, PUBLISHING_LOCK } = require('./publishing');
const { isAccessRevision, isAccessUpdate, requireAccessRevision, accessError } = require('../utils/shareAccess');
const { isContentRevision, assertContentRevision, contentError, contentSnapshotHash } = require('../utils/contentRevision');
const {
  buildManagementDailyStats,
  managementDateRange,
  managementRecentStart
} = require('../utils/management-time');

/**
 * Row-level revision provenance (parent #24 §3): SHA-256 snapshot hash over
 * the fixed payload, the real write path, a trusted actor where one exists
 * (never secrets or invented identities) and the nullable restore origin
 * (always NULL until a later ticket adds a real restore entry point).
 * Repository-level defaults keep direct test fixtures honest-by-label; every
 * production entry point passes explicit provenance (asserted in tests).
 */
function revisionProvenance(pageOrOptions, defaults) {
  return {
    snapshotHash: contentSnapshotHash(pageOrOptions),
    source: pageOrOptions.actorSource || defaults.source,
    actor: pageOrOptions.actorIdentity === undefined ? (defaults.actor || null) : (pageOrOptions.actorIdentity || null),
    restoredFrom: null
  };
}

/**
 * Remote content projection returned with a 412 so the owner dashboard can
 * show the real difference without granting any new management API surface.
 * Never includes policy fields (password, expiry, favorite, views).
 */
function revisionConflictProjection(page) {
  return {
    id: page.id,
    currentRevision: String(page.current_revision),
    htmlContent: page.html_content,
    codeType: page.code_type || 'html',
    title: page.title,
    description: page.description,
    markdownTheme: page.markdown_theme || null
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

  async getPublishingWritesPaused() {
    const result = await this.pool.query('SELECT publishing_writes_paused FROM site_settings WHERE id = 1');
    const paused = result.rows[0]?.publishing_writes_paused;
    if (typeof paused !== 'boolean') throw new Error('Publishing setting is unavailable');
    return paused;
  }

  async setPublishingWritesPaused(paused) {
    if (typeof paused !== 'boolean') throw new TypeError('paused must be a boolean');
    return this.withTransaction(async transaction => {
      await transaction.pool.query('SELECT pg_advisory_xact_lock($1)', [PUBLISHING_LOCK]);
      const result = await transaction.pool.query(
        'UPDATE site_settings SET publishing_writes_paused = $1, updated_at = $2 WHERE id = 1 RETURNING id',
        [paused, Date.now()]
      );
      if (result.rowCount !== 1) throw new Error('Publishing setting is unavailable');
      return { publishingWritesPaused: paused };
    });
  }

  async withTransaction(operation) {
    const client = await this.pool.connect();
    let queryError;
    const transaction = Object.create(this);
    transaction.pool = { query: async (...args) => {
      try { return await client.query(...args); }
      catch (error) { queryError ||= error; throw error; }
    } };
    transaction.transactionClient = transaction.pool;
    try {
      await client.query('BEGIN');
      const result = await operation(transaction);
      // PostgreSQL COMMIT on an aborted transaction reports ROLLBACK, not an
      // exception. Never turn a swallowed SQL/audit failure into HTTP success.
      if (queryError) throw queryError;
      const committed = await client.query('COMMIT');
      if (committed.command !== 'COMMIT') throw new Error('Publishing transaction did not commit');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async withPublishingTransaction(operation) {
    return this.withTransaction(async transaction => {
      await transaction.pool.query('SELECT pg_advisory_xact_lock_shared($1)', [PUBLISHING_LOCK]);
      return operation(transaction);
    });
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

  async setHomepagePasswordRequired({ passwordRequired, ip }) {
    if (typeof passwordRequired !== 'boolean') {
      throw new TypeError('passwordRequired must be a boolean');
    }

    const client = this.transactionClient || await this.pool.connect();

    try {
      if (!this.transactionClient) await client.query('BEGIN');
      const result = await client.query(
        'SELECT homepage_password_required FROM site_settings WHERE id = 1 FOR UPDATE'
      );
      const previousValue = result.rows[0]?.homepage_password_required;

      if (typeof previousValue !== 'boolean') {
        throw new Error('Homepage access setting is unavailable');
      }

      if (previousValue === passwordRequired) {
        if (!this.transactionClient) await client.query('COMMIT');
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
      if (!this.transactionClient) await client.query('COMMIT');

      return { passwordRequired, changed: true };
    } catch (error) {
      try {
        if (!this.transactionClient) await client.query('ROLLBACK');
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    } finally {
      if (!this.transactionClient) client.release();
    }
  }

  async create(page) {
    const result = await this.pool.query(
      `
        INSERT INTO pages (
          id, html_content, created_at, password_hash, encrypted_password, is_protected,
          code_type, title, description, expires_at, markdown_theme
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO NOTHING
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

    if (result.rowCount === 0) throw Object.assign(new Error('Share id already exists'), { code: '23505' });
    // Every creation path (web, Share API, clone) writes the baseline snapshot
    // on the same client/transaction; there is no versionless write entry.
    const provenance = revisionProvenance(page, { source: 'web', actor: null });
    await this.pool.query(
      `
        INSERT INTO share_revisions (
          share_id, revision, html_content, code_type, title, description, markdown_theme, created_at,
          snapshot_hash, source, actor, restored_from
        )
        VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)
      `,
      [
        page.id,
        page.htmlContent,
        page.codeType || 'html',
        page.title || null,
        page.description || null,
        page.markdownTheme || null,
        page.createdAt,
        provenance.snapshotHash,
        provenance.source,
        provenance.actor
      ]
    );
    return { id: page.id };
  }

  async listContentRevisions(shareId) {
    const result = await this.pool.query(
      `
        SELECT share_id, revision, html_content, code_type, title, description, markdown_theme, created_at,
               snapshot_hash, source, actor, restored_from
        FROM share_revisions
        WHERE share_id = $1
        ORDER BY revision ASC
      `,
      [shareId]
    );
    return result.rows;
  }

  /**
   * Owner history page (#31): bounded, metadata-only, ordered by the exact
   * BIGINT revision value (never Number or string order) and never selecting
   * html_content, so list responses cannot aggregate bodies.
   */
  async listContentRevisionPage(shareId, { limit = 20, offset = 0 } = {}) {
    const parsedLimit = Math.trunc(Number(limit));
    const safeLimit = Math.min(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20, 100);
    const parsedOffset = Math.trunc(Number(offset));
    const safeOffset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
    const [pageResult, countResult] = await Promise.all([
      this.pool.query(
        `
          SELECT share_id, revision, created_at, source, restored_from, purged_at
          FROM share_revisions
          WHERE share_id = $1
          ORDER BY revision DESC
          LIMIT $2 OFFSET $3
        `,
        [shareId, safeLimit, safeOffset]
      ),
      this.pool.query('SELECT count(*) AS total FROM share_revisions WHERE share_id = $1', [shareId])
    ]);
    return { items: pageResult.rows, total: String(countResult.rows[0].total) };
  }

  /**
   * Single bounded snapshot read for owner history (#31). The revision value
   * is validated as an exact decimal revision BEFORE any query runs.
   */
  async getContentRevision(shareId, revision) {
    if (!isContentRevision(revision)) {
      throw contentError(400, 'content revision must be a positive decimal string');
    }
    const result = await this.pool.query(
      `
        SELECT share_id, revision, html_content, code_type, title, description, markdown_theme, created_at,
               snapshot_hash, source, actor, restored_from, purged_at
        FROM share_revisions
        WHERE share_id = $1 AND revision = $2
        LIMIT 1
      `,
      [shareId, revision]
    );
    return result.rows[0] || null;
  }

  /**
   * Revision purge (#34). MUST run inside a publishing transaction on the
   * transaction client: the Share row is locked FOR UPDATE first, the
   * current-pointer recheck reads that locked row, and the payload clearing
   * plus the sensitive-receipt scrub commit in the SAME transaction.
   */
  async purgeContentRevision(id, revision) {
    if (!this.transactionClient) {
      throw new Error('Revision purge requires a publishing transaction');
    }
    if (!isContentRevision(revision)) {
      throw contentError(400, 'content revision must be a positive decimal string');
    }
    const normalized = String(revision);

    // Lock the Share row first (#24 §9): the current-version recheck below
    // reads the LOCKED row, so a concurrent restore/save cannot interleave
    // between the check and the payload clearing.
    const current = await this.pool.query('SELECT id, current_revision FROM pages WHERE id = $1 FOR UPDATE', [id]);
    if (current.rowCount === 0) return { found: false };
    if (String(current.rows[0].current_revision) === normalized) {
      return { found: true, current: true };
    }

    const existing = await this.pool.query(
      'SELECT revision, restored_from, purged_at FROM share_revisions WHERE share_id = $1 AND revision = $2 FOR UPDATE',
      [id, normalized]
    );
    if (existing.rowCount === 0) return { found: true, revision: false };
    const row = existing.rows[0];
    const alreadyPurged = row.purged_at !== null && row.purged_at !== undefined;
    const purgedAt = alreadyPurged ? row.purged_at : Date.now();

    if (!alreadyPurged) {
      // Payload bytes go; identity, original time, action, provenance and
      // restore origin stay. Snapshot hash is dropped with the payload: a
      // surviving canonical digest would keep a verifiable trace of the
      // cleared title/description/theme.
      await this.pool.query(
        `
          UPDATE share_revisions
          SET html_content = NULL, title = NULL, description = NULL, markdown_theme = NULL,
              snapshot_hash = NULL, purged_at = $3
          WHERE share_id = $1 AND revision = $2
        `,
        [id, normalized, purgedAt]
      );
    }

    // Receipt scrub, same transaction: ONLY records whose committed result
    // is this exact Share+Revision, across every actor namespace. Other
    // revisions of this Share and other Shares keep their receipts.
    await this.pool.query(
      `
        UPDATE publish_operations
        SET receipt_encrypted = NULL,
            purged_at = COALESCE(purged_at, $3)
        WHERE result_share_id = $1 AND result_revision = $2::bigint
      `,
      [id, normalized, purgedAt]
    );

    return { found: true, current: false, revision: true, alreadyPurged, purgedAt: Number(purgedAt) };
  }

  async listPagesMissingBaselineRevision(limit = 200) {
    const result = await this.pool.query(
      `
        SELECT p.id, p.html_content, p.code_type, p.title, p.description, p.markdown_theme, p.created_at, p.current_revision
        FROM pages p
        LEFT JOIN share_revisions r ON r.share_id = p.id AND r.revision = 1
        WHERE r.share_id IS NULL
        ORDER BY p.created_at ASC
        LIMIT $1
      `,
      [limit]
    );
    return result.rows;
  }

  async listPagesNeedingTitleBackfill(limit = 200) {
    const result = await this.pool.query(
      `
        SELECT id, html_content, code_type, title, created_at
        FROM pages
        WHERE title IS NULL OR title = '' OR title = id
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [limit]
    );
    return result.rows;
  }

  /** Dedicated baseline-window write; only the backfill job may call this. */
  async createBaselineRevision(page) {
    const result = await this.pool.query(
      `
        INSERT INTO share_revisions (
          share_id, revision, html_content, code_type, title, description, markdown_theme, created_at,
          snapshot_hash, source, actor, restored_from
        )
        VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, 'baseline-backfill', $9, NULL)
        ON CONFLICT (share_id, revision) DO NOTHING
      `,
      [
        page.id,
        page.htmlContent,
        page.codeType || 'html',
        page.title || null,
        page.description || null,
        page.markdownTheme || null,
        page.createdAt,
        contentSnapshotHash(page),
        page.actorIdentity || 'maintenance:baseline-backfill'
      ]
    );
    return result.rowCount > 0;
  }

  async getById(id) {
    const result = await this.pool.query('SELECT * FROM pages WHERE id = $1 LIMIT 1', [id]);
    return result.rows[0] || null;
  }

  async getProtectionBaseline(id) {
    const result = await this.pool.query('SELECT access_revision FROM pages WHERE id = $1 LIMIT 1', [id]);
    return result.rows[0] ? { accessRevision: result.rows[0].access_revision } : null;
  }

  async getPublicById(id, now = Date.now()) {
    // #35 public unification: an unpublished Share has NO public projection.
    // Returning null routes every public surface (view page, OG, metadata
    // API, password POST) through the existing neutral missing-404 path, and
    // unpublished is evaluated BEFORE expiry: expiry only ever classifies
    // published Shares, so an expired+unpublished Share reads as 404.
    const result = await this.pool.query(
      `
        SELECT *, (expires_at IS NOT NULL AND expires_at <= $2) AS is_expired
        FROM pages
        WHERE id = $1
          AND published
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
        SELECT id, created_at, code_type, title, description, is_protected, is_favorite, encrypted_password, expires_at, COALESCE(view_count, 0) AS view_count, published, access_revision
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

  async recordViewEvent(id, now = Date.now(), accessRevision = null) {
    if (this.publishingWritesPaused) {
      const state = await this.pool.query('SELECT is_protected, expires_at, access_revision, published FROM pages WHERE id = $1 LIMIT 1', [id]);
      const page = state.rows[0];
      if (!page) return 'not_found';
      if (page.published === false) return 'not_found';
      if (page.expires_at !== null && Number(page.expires_at) <= now) return 'expired';
      if (page.is_protected === 1 && page.access_revision !== accessRevision) return 'protected';
      throw maintenanceError();
    }
    const updateResult = await this.pool.query(
      `
        UPDATE pages
        SET view_count = COALESCE(view_count, 0) + 1
        WHERE id = $1
          AND published
          AND (expires_at IS NULL OR expires_at > $2)
          AND (COALESCE(is_protected, 0) <> 1 OR access_revision = $3::bigint)
        RETURNING id
      `,
      [id, now, isAccessRevision(accessRevision) ? accessRevision : null]
    );

    if (updateResult.rowCount > 0) {
      return 'counted';
    }

    const stateResult = await this.pool.query(
      'SELECT is_protected, expires_at, published FROM pages WHERE id = $1 LIMIT 1',
      [id]
    );
    const page = stateResult.rows[0];

    if (!page) {
      return 'not_found';
    }

    // #35: unpublished never counts and reads as missing (404), evaluated
    // before expiry so expired+unpublished also answers 404.
    if (page.published === false) {
      return 'not_found';
    }

    if (page.expires_at !== null && Number(page.expires_at) <= now) {
      return 'expired';
    }

    return page.is_protected === 1 ? 'protected' : 'not_found';
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
    return this.updatePage(id, options);
  }

  /**
   * #35 owner publication transition. One atomic statement sets `published`
   * AND advances `access_revision`; the row is locked and compared against
   * the caller's expected access revision first (412 on a stale baseline).
   * A same-state transition is the approved unchanged no-op: no bump, no
   * side effects. Password, expiry, content revisions, history, Favorite and
   * view counts are never touched.
   */
  async setPublished(id, options) {
    if (!this.transactionClient) {
      return this.withTransaction(transaction => transaction.setPublished(id, options));
    }
    return this.setPublishedInTransaction(id, options);
  }

  async setPublishedInTransaction(id, options) {
    requireAccessRevision(options.expectedAccessRevision);
    const current = await this.pool.query('SELECT * FROM pages WHERE id = $1 FOR UPDATE', [id]);
    if (current.rowCount === 0) return null;
    const page = current.rows[0];
    if (String(page.access_revision) !== String(options.expectedAccessRevision)) {
      throw accessError(412, 'Share 访问设置已更改，请刷新后重新确认；未保存的输入已保留。');
    }
    const target = options.published === true;
    if (Boolean(page.published) === target) {
      return { changed: false, page };
    }
    const updated = await this.pool.query(
      'UPDATE pages SET published = $2, access_revision = access_revision + 1 WHERE id = $1 RETURNING *',
      [id, target]
    );
    return { changed: true, page: updated.rows[0] };
  }

  async setFavorite(id, isFavorite) {
    if (typeof isFavorite !== 'boolean') {
      throw new TypeError('isFavorite must be a boolean');
    }

    const result = await this.pool.query(
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
    );
    const row = result.rows[0];

    return {
      found: row.found,
      changed: row.changed,
      isFavorite: row.is_favorite,
      previousValue: row.previous_value
    };
  }

  async updatePage(id, options) {
    // Baseline validation, snapshot decision and the materialized write must
    // be atomic. Calls from publishing transactions reuse the transaction
    // client; direct repository calls wrap themselves in a dedicated one so
    // the CAS can never interleave with another writer between statements.
    if (!this.transactionClient) {
      return this.withTransaction(transaction => transaction.updatePage(id, options));
    }
    return this.updatePageInTransaction(id, options);
  }

  async updatePageInTransaction(id, options) {
    const conditional = isAccessUpdate(options) || options.accessPrecondition;
    if (conditional) requireAccessRevision(options.expectedAccessRevision);
    const contentSubmitted = options.htmlContent !== undefined || options.title !== undefined
      || options.description !== undefined || options.markdownTheme !== undefined;
    const contentConditional = contentSubmitted || options.contentPrecondition;
    if (contentConditional && !isContentRevision(options.expectedContentRevision)) {
      throw contentError(options.expectedContentRevision === undefined ? 428 : 400,
        options.expectedContentRevision === undefined
          ? '请刷新 Share 后重新保存内容；未保存的输入已保留。'
          : 'content baseline must be a positive decimal string');
    }

    // Lock the row first: baseline comparison, snapshot decision and the
    // materialized write all observe the same committed state inside this
    // transaction, and the lock releases only at COMMIT/ROLLBACK.
    const current = await this.pool.query('SELECT * FROM pages WHERE id = $1 FOR UPDATE', [id]);
    if (current.rowCount === 0) return false;
    const page = current.rows[0];

    if (contentConditional) {
      try {
        assertContentRevision(options.expectedContentRevision, page.current_revision);
      } catch (error) {
        if (error.code === 'CONTENT_REVISION_CONFLICT') {
          error.current = revisionConflictProjection(page);
        }
        throw error;
      }
    }
    if (conditional && String(page.access_revision) !== String(options.expectedAccessRevision)) {
      throw accessError(412, 'Share 访问设置已更改，请刷新后重新确认；未保存的输入已保留。');
    }

    // Snapshot comparison runs on the canonical text values: an unchanged
    // candidate must not create a revision, even when resubmitted.
    const nextContent = {
      html_content: options.htmlContent !== undefined ? options.htmlContent : page.html_content,
      title: options.title !== undefined ? (options.title || null) : page.title,
      description: options.description !== undefined ? (options.description || null) : page.description,
      markdown_theme: options.markdownTheme !== undefined ? (options.markdownTheme || null) : page.markdown_theme
    };
    const contentChanged = contentSubmitted && (
      nextContent.html_content !== page.html_content
      || nextContent.title !== page.title
      || nextContent.description !== page.description
      || nextContent.markdown_theme !== page.markdown_theme
    );

    const fields = [];
    const params = [];
    let paramIndex = 1;
    const bumps = [];
    if (options.revokeAccess === true || options.isProtected === true) bumps.push('TRUE');
    else if (options.isProtected !== undefined) bumps.push('is_protected = 1');

    if (contentChanged) {
      fields.push(`html_content = $${paramIndex}`);
      params.push(nextContent.html_content);
      paramIndex += 1;
      fields.push(`title = $${paramIndex}`);
      params.push(nextContent.title);
      paramIndex += 1;
      fields.push(`description = $${paramIndex}`);
      params.push(nextContent.description);
      paramIndex += 1;
      fields.push(`markdown_theme = $${paramIndex}`);
      params.push(nextContent.markdown_theme);
      paramIndex += 1;
      fields.push('current_revision = current_revision + 1');
    }
    if (options.expiresAt !== undefined) {
      bumps.push(`expires_at IS DISTINCT FROM $${paramIndex}::bigint`);
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

    if (bumps.length) fields.push(`access_revision = access_revision + CASE WHEN ${bumps.join(' OR ')} THEN 1 ELSE 0 END`);
    if (fields.length === 0) {
      if (!options.returnUpdated) return true;
      fields.push('access_revision = access_revision');
    }

    params.push(id);
    const result = await this.pool.query(
      `UPDATE pages SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params
    );
    if (result.rowCount === 0) return false;
    const updated = result.rows[0];

    if (contentChanged) {
      // Snapshot and materialized projection commit in the same client
      // transaction; a failure here rolls the whole save back.
      const snapshotPayload = {
        htmlContent: nextContent.html_content,
        codeType: page.code_type || 'html',
        title: nextContent.title,
        description: nextContent.description,
        markdownTheme: nextContent.markdown_theme
      };
      await this.pool.query(
        `
          INSERT INTO share_revisions (
            share_id, revision, html_content, code_type, title, description, markdown_theme, created_at,
            snapshot_hash, source, actor, restored_from
          )
          VALUES ($1, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL)
        `,
        [
          id,
          updated.current_revision,
          nextContent.html_content,
          snapshotPayload.codeType,
          nextContent.title,
          nextContent.description,
          nextContent.markdown_theme,
          Date.now(),
          contentSnapshotHash(snapshotPayload),
          options.actorSource || 'dashboard-edit',
          options.actorIdentity === undefined ? 'owner-dashboard' : (options.actorIdentity || null)
        ]
      );
    }

    return options.returnUpdated ? updated : true;
  }

  async restorePageRevision(id, options) {
    // Restore is a content-family write with its own CAS: calls from
    // publishing transactions reuse the transaction client; direct calls
    // wrap themselves in a dedicated one so the CAS cannot interleave.
    if (!this.transactionClient) {
      return this.withTransaction(transaction => transaction.restorePageRevision(id, options));
    }
    return this.restorePageRevisionInTransaction(id, options);
  }

  async restorePageRevisionInTransaction(id, options) {
    const sourceRevision = String(options.sourceRevision);
    if (!isContentRevision(sourceRevision)) {
      throw contentError(400, 'content revision must be a positive decimal string');
    }

    // Lock the Share row first: baseline CAS, source availability, the
    // unchanged comparison and the materialized write all observe the same
    // committed state inside this transaction (#24 §9 delete/purge-vs-restore
    // discipline without the purge feature).
    const current = await this.pool.query('SELECT * FROM pages WHERE id = $1 FOR UPDATE', [id]);
    if (current.rowCount === 0) return null;
    const page = current.rows[0];

    try {
      assertContentRevision(options.expectedContentRevision, page.current_revision);
    } catch (error) {
      if (error.code === 'CONTENT_REVISION_CONFLICT') {
        error.current = revisionConflictProjection(page);
      }
      throw error;
    }

    // The source snapshot must exist WITH its payload: a payload-less row is
    // a future purge tombstone (#34) and is rejected as an invalid source,
    // never silently treated as empty content.
    const sourceRow = await this.getContentRevision(id, sourceRevision);
    if (!sourceRow || typeof sourceRow.html_content !== 'string') {
      throw Object.assign(
        new Error('恢复来源不存在或已被清除，不能作为恢复来源'),
        { status: 404, code: 'RESTORE_SOURCE_INVALID' }
      );
    }

    const nextContent = {
      html_content: sourceRow.html_content,
      title: sourceRow.title,
      description: sourceRow.description,
      markdown_theme: sourceRow.markdown_theme
    };
    const snapshotUnchanged =
      nextContent.html_content === page.html_content
      && nextContent.title === page.title
      && nextContent.description === page.description
      && nextContent.markdown_theme === page.markdown_theme;

    if (snapshotUnchanged) {
      // Same-snapshot restore is the approved no-op: success, no new
      // revision, no duplicate body version. The caller records the
      // operation result; nothing else about the Share moves.
      return { changed: false, page };
    }

    const result = await this.pool.query(
      `
        UPDATE pages
        SET html_content = $2, title = $3, description = $4, markdown_theme = $5,
            current_revision = current_revision + 1
        WHERE id = $1
        RETURNING *
      `,
      [id, nextContent.html_content, nextContent.title, nextContent.description, nextContent.markdown_theme]
    );
    if (result.rowCount === 0) return null;
    const updated = result.rows[0];

    // New Revision + provenance commit in the SAME transaction (007
    // restored_from semantics; no purge tombstone is created here).
    const snapshotPayload = {
      htmlContent: nextContent.html_content,
      codeType: page.code_type || 'html',
      title: nextContent.title,
      description: nextContent.description,
      markdownTheme: nextContent.markdown_theme
    };
    await this.pool.query(
      `
        INSERT INTO share_revisions (
          share_id, revision, html_content, code_type, title, description, markdown_theme, created_at,
          snapshot_hash, source, actor, restored_from
        )
        VALUES ($1, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::bigint)
      `,
      [
        id,
        updated.current_revision,
        nextContent.html_content,
        snapshotPayload.codeType,
        nextContent.title,
        nextContent.description,
        nextContent.markdown_theme,
        Date.now(),
        contentSnapshotHash(snapshotPayload),
        options.actorSource || 'dashboard-restore',
        options.actorIdentity === undefined ? 'owner-dashboard' : (options.actorIdentity || null),
        sourceRevision
      ]
    );

    return { changed: true, page: updated };
  }

  async deletePage(id) {
    const result = await this.pool.query('DELETE FROM pages WHERE id = $1', [id]);
    return result.rowCount > 0;
  }

  async deletePages(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    // Deterministic row-lock order for batch deletes: sorted Share ids.
    const sorted = [...ids].sort();
    const result = await this.pool.query('DELETE FROM pages WHERE id = ANY($1)', [sorted]);
    return result.rowCount;
  }

  // Publish operation records (#24 §8). The advisory transaction lock keeps
  // concurrent same-key creators serialized before the lookup; the primary
  // key on (actor_namespace, request_id) stays the final guard.
  async lockPublishingOperation({ actorNamespace, requestId }) {
    if (!this.transactionClient) throw new Error('Operation locking requires a publishing transaction');
    await this.pool.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [actorNamespace, requestId]);
    return true;
  }

  async findPublishingOperation(actorNamespace, requestId) {
    const result = await this.pool.query(
      'SELECT * FROM publish_operations WHERE actor_namespace = $1 AND request_id = $2 LIMIT 1',
      [actorNamespace, requestId]
    );
    return result.rows[0] || null;
  }

  async findPublishingOperationsByRequestId(requestId) {
    const result = await this.pool.query(
      'SELECT * FROM publish_operations WHERE request_id = $1 ORDER BY created_at ASC',
      [requestId]
    );
    return result.rows;
  }

  async createPublishingOperation(record) {
    const result = await this.pool.query(
      `
        INSERT INTO publish_operations (
          actor_namespace, request_id, action, request_digest, target_id,
          result_share_id, result_revision, result_access_revision,
          receipt_encrypted, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (actor_namespace, request_id) DO NOTHING
      `,
      [
        record.actor_namespace,
        record.request_id,
        record.action,
        record.request_digest,
        record.target_id ?? null,
        record.result_share_id ?? null,
        record.result_revision ?? null,
        record.result_access_revision ?? null,
        record.receipt_encrypted ?? null,
        record.created_at
      ]
    );
    if (result.rowCount === 0) {
      throw Object.assign(new Error('Publishing operation already exists'), { code: '23505' });
    }
    return true;
  }

  async clearPublishingOperationsForShares(shareIds) {
    if (!Array.isArray(shareIds) || shareIds.length === 0) return 0;
    // Runs in the delete transaction, after the Share rows are locked/deleted:
    // the sensitive receipt payload is dropped and a non-content tombstone
    // (deleted_at) remains so late replays never revive the result.
    const sorted = [...shareIds].sort();
    const result = await this.pool.query(
      `
        UPDATE publish_operations
        SET receipt_encrypted = NULL, deleted_at = COALESCE(deleted_at, $2)
        WHERE result_share_id = ANY($1)
      `,
      [sorted, Date.now()]
    );
    return result.rowCount;
  }

  async createApiKey(apiKey) {
    const scopes = Array.isArray(apiKey.scopes) && apiKey.scopes.length > 0 ? apiKey.scopes : ['share:create'];
    const result = await this.pool.query(
      `
        INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at, scopes, auto_grant_new_share_edit)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        RETURNING id, name, key_prefix, created_at, last_used_at, credential_version, scopes, auto_grant_new_share_edit
      `,
      [apiKey.id, apiKey.name, apiKey.keyHash, apiKey.keyPrefix, apiKey.createdAt,
        JSON.stringify(scopes), apiKey.autoGrantNewShareEdit === true]
    );

    return result.rows[0];
  }

  async listApiKeys() {
    const result = await this.pool.query(
      `
        SELECT id, name, key_prefix, created_at, last_used_at, credential_version, scopes, auto_grant_new_share_edit
        FROM api_keys
        ORDER BY created_at DESC
      `
    );

    return result.rows;
  }

  async getApiKeyById(id) {
    const result = await this.pool.query(
      'SELECT id, name, key_hash, key_prefix, created_at, last_used_at, credential_version, scopes, auto_grant_new_share_edit FROM api_keys WHERE id = $1 LIMIT 1',
      [id]
    );

    return result.rows[0] || null;
  }

  async verifyApiKeyForWrite(identity) {
    if (!this.transactionClient) throw new Error('Key verification requires a publishing transaction');
    const result = await this.pool.query('SELECT credential_version FROM api_keys WHERE id = $1 FOR UPDATE', [identity.id]);
    if (result.rows[0]?.credential_version !== identity.credentialVersion) throw invalidApiKey();
  }

  async rotateApiKey(id, keyHash) {
    const result = await this.pool.query(
      `UPDATE api_keys SET key_hash = $2, credential_version = credential_version + 1
       WHERE id = $1
       RETURNING id, name, key_prefix, created_at, last_used_at, credential_version, scopes, auto_grant_new_share_edit`,
      [id, keyHash]
    );
    return result.rows[0] || null;
  }

  async deleteApiKey(id) {
    const result = await this.pool.query('DELETE FROM api_keys WHERE id = $1', [id]);
    return result.rowCount > 0;
  }

  async touchApiKey(id, usedAt = Date.now()) {
    await this.pool.query('UPDATE api_keys SET last_used_at = $2 WHERE id = $1 AND EXISTS (SELECT 1 FROM site_settings WHERE id = 1 AND publishing_writes_paused = FALSE)', [id, usedAt]);
  }

  // Per-Share read grants (#36, parent #24 §6/§8). Grant and revoke take the
  // Key row lock FIRST and the Share row lock second — the §8 order — so a
  // concurrent rotation serializes before any grant decision, and a grant
  // never interleaves with a Share deletion mid-flight. Both run inside the
  // caller's publishing transaction; a missing Key or Share is reported by
  // status, never by throwing past the audit boundary.
  //
  // The Key's `share:read` scope follows its grants (#36): the first read
  // grant unlocks the read API family for this credential, revoking the last
  // one closes it again. The column therefore never advertises a capability
  // the key cannot actually use, and migrated create-only keys stay
  // create-only until the owner explicitly grants a Share.
  async grantShareRead({ apiKeyId, shareId }) {
    if (!this.transactionClient) throw new Error('Grant writes require a publishing transaction');

    const keyRow = await this.pool.query('SELECT id, scopes FROM api_keys WHERE id = $1 FOR UPDATE', [apiKeyId]);
    if (keyRow.rowCount === 0) return { status: 'key-not-found' };

    const shareRow = await this.pool.query('SELECT id FROM pages WHERE id = $1 FOR UPDATE', [shareId]);
    if (shareRow.rowCount === 0) return { status: 'share-not-found' };

    const existing = await this.pool.query(
      'SELECT can_read FROM share_grants WHERE api_key_id = $1 AND share_id = $2 FOR UPDATE',
      [apiKeyId, shareId]
    );

    let status;
    if (existing.rowCount > 0) {
      if (existing.rows[0].can_read === true) return { status: 'unchanged' };
      await this.pool.query(
        'UPDATE share_grants SET can_read = TRUE WHERE api_key_id = $1 AND share_id = $2',
        [apiKeyId, shareId]
      );
      status = 'granted';
    } else {
      await this.pool.query(
        'INSERT INTO share_grants (api_key_id, share_id, can_read, created_at) VALUES ($1, $2, TRUE, $3)',
        [apiKeyId, shareId, Date.now()]
      );
      status = 'granted';
    }

    await this.ensureApiKeyScope(apiKeyId, 'share:read', keyRow.rows[0].scopes);
    return { status };
  }

  async ensureApiKeyScope(apiKeyId, scope, currentScopes) {
    const scopes = Array.isArray(currentScopes) ? currentScopes : [];
    if (scopes.includes(scope)) return;
    await this.pool.query(
      'UPDATE api_keys SET scopes = $2::jsonb WHERE id = $1',
      [apiKeyId, JSON.stringify([...scopes, scope])]
    );
  }

  async dropApiKeyScopeIfUnused(apiKeyId, scope) {
    const remaining = await this.pool.query(
      'SELECT EXISTS (SELECT 1 FROM share_grants WHERE api_key_id = $1 AND can_read = TRUE) AS kept',
      [apiKeyId]
    );
    if (remaining.rows[0]?.kept === true) return;
    await this.pool.query(
      `UPDATE api_keys
         SET scopes = COALESCE((
           SELECT jsonb_agg(s.value)
             FROM jsonb_array_elements(scopes) s
            WHERE s.value <> to_jsonb($2::text)
         ), '[]'::jsonb)
       WHERE id = $1`,
      [apiKeyId, scope]
    );
  }

  async revokeShareRead({ apiKeyId, shareId }) {
    if (!this.transactionClient) throw new Error('Grant writes require a publishing transaction');

    const keyRow = await this.pool.query('SELECT id FROM api_keys WHERE id = $1 FOR UPDATE', [apiKeyId]);
    if (keyRow.rowCount === 0) return { status: 'key-not-found' };

    // Preserve Key → Share lock order, including idempotent revocations.
    // A deleted Share has already cascaded its grants away.
    const shareRow = await this.pool.query('SELECT id FROM pages WHERE id = $1 FOR UPDATE', [shareId]);
    if (shareRow.rowCount === 0) return { status: 'unchanged' };

    const existing = await this.pool.query(
      'SELECT can_read, can_update, can_publish FROM share_grants WHERE api_key_id = $1 AND share_id = $2 FOR UPDATE',
      [apiKeyId, shareId]
    );
    if (existing.rowCount === 0) return { status: 'unchanged' };

    const grant = existing.rows[0];
    if (grant.can_read !== true) return { status: 'unchanged' };

    // The schema requires update ⇒ read. Do not silently discard a future
    // edit grant or violate the constraint when its read bit is revoked.
    if (grant.can_update === true) return { status: 'dependent-grant' };

    if (grant.can_publish === true) {
      await this.pool.query(
        'UPDATE share_grants SET can_read = FALSE WHERE api_key_id = $1 AND share_id = $2',
        [apiKeyId, shareId]
      );
    } else {
      await this.pool.query(
        'DELETE FROM share_grants WHERE api_key_id = $1 AND share_id = $2',
        [apiKeyId, shareId]
      );
    }

    await this.dropApiKeyScopeIfUnused(apiKeyId, 'share:read');
    return { status: 'revoked' };
  }

  async getShareGrant(apiKeyId, shareId) {
    const result = await this.pool.query(
      'SELECT api_key_id, share_id, can_read, can_update, can_publish, created_at FROM share_grants WHERE api_key_id = $1 AND share_id = $2 LIMIT 1',
      [apiKeyId, shareId]
    );
    return result.rows[0] || null;
  }

  async listShareGrantsForKey(apiKeyId) {
    const result = await this.pool.query(
      `
        SELECT g.share_id, g.can_read, g.can_update, g.can_publish, g.created_at, p.title AS share_title
        FROM share_grants g
        LEFT JOIN pages p ON p.id = g.share_id
        WHERE g.api_key_id = $1
        ORDER BY g.created_at ASC, g.share_id ASC
      `,
      [apiKeyId]
    );
    return result.rows;
  }

  /**
   * Stable-cursor page of Shares a Key may read (#36): ordered by
   * (created_at, id) ASC, cursor strictly after the previous page's last
   * row, so inserts between pages never skip or duplicate entries. Rows
   * carry NO secret, grant, password or Favorite state — list is metadata
   * only and never leaks beyond granted Shares.
   */
  async listGrantedSharePage({ apiKeyId, limit, cursorCreatedAt = null, cursorId = null }) {
    const result = await this.pool.query(
      `
        SELECT p.id, p.created_at, p.code_type, p.title, p.description, p.markdown_theme,
               p.current_revision, p.access_revision, p.published, p.is_protected, p.expires_at
        FROM share_grants g
        JOIN pages p ON p.id = g.share_id
        WHERE g.api_key_id = $1 AND g.can_read = TRUE
          AND ($2::bigint IS NULL OR (p.created_at, p.id) > ($2::bigint, $3::text))
        ORDER BY p.created_at ASC, p.id ASC
        LIMIT $4
      `,
      [apiKeyId, cursorCreatedAt, cursorId, limit]
    );
    return result.rows;
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
