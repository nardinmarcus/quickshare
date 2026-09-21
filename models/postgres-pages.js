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
          SELECT share_id, revision, created_at, source, restored_from
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
               snapshot_hash, source, actor, restored_from
        FROM share_revisions
        WHERE share_id = $1 AND revision = $2
        LIMIT 1
      `,
      [shareId, revision]
    );
    return result.rows[0] || null;
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

  async recordViewEvent(id, now = Date.now(), accessRevision = null) {
    if (this.publishingWritesPaused) {
      const state = await this.pool.query('SELECT is_protected, expires_at, access_revision FROM pages WHERE id = $1 LIMIT 1', [id]);
      const page = state.rows[0];
      if (!page) return 'not_found';
      if (page.expires_at !== null && Number(page.expires_at) <= now) return 'expired';
      if (page.is_protected === 1 && page.access_revision !== accessRevision) return 'protected';
      throw maintenanceError();
    }
    const updateResult = await this.pool.query(
      `
        UPDATE pages
        SET view_count = COALESCE(view_count, 0) + 1
        WHERE id = $1
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

  async deletePage(id) {
    const result = await this.pool.query('DELETE FROM pages WHERE id = $1', [id]);
    return result.rowCount > 0;
  }

  async deletePages(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    const result = await this.pool.query('DELETE FROM pages WHERE id = ANY($1)', [ids]);
    return result.rowCount;
  }

  async createApiKey(apiKey) {
    const result = await this.pool.query(
      `
        INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, key_prefix, created_at, last_used_at, credential_version
      `,
      [apiKey.id, apiKey.name, apiKey.keyHash, apiKey.keyPrefix, apiKey.createdAt]
    );

    return result.rows[0];
  }

  async listApiKeys() {
    const result = await this.pool.query(
      `
        SELECT id, name, key_prefix, created_at, last_used_at, credential_version
        FROM api_keys
        ORDER BY created_at DESC
      `
    );

    return result.rows;
  }

  async getApiKeyById(id) {
    const result = await this.pool.query(
      'SELECT id, name, key_hash, key_prefix, created_at, last_used_at, credential_version FROM api_keys WHERE id = $1 LIMIT 1',
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
       RETURNING id, name, key_prefix, created_at, last_used_at, credential_version`,
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
