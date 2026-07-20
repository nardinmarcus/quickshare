const DAY_MS = 24 * 60 * 60 * 1000;
const { createPostgresPool } = require('./postgres-config');

function buildDailyStats(createdAtRows, days = 14) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const startAt = todayStart.getTime() - ((days - 1) * DAY_MS);
  const counts = new Map();

  for (let index = 0; index < days; index += 1) {
    const timestamp = startAt + (index * DAY_MS);
    counts.set(timestamp, 0);
  }

  createdAtRows.forEach((row) => {
    const createdAt = Number(row.created_at);
    const day = new Date(createdAt);
    day.setHours(0, 0, 0, 0);
    const dayStart = day.getTime();

    if (counts.has(dayStart)) {
      counts.set(dayStart, counts.get(dayStart) + 1);
    }
  });

  return Array.from(counts.entries()).map(([timestamp, count]) => ({
    date: new Date(timestamp).toISOString().slice(0, 10),
    label: new Date(timestamp).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }),
    count
  }));
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

  async setHomepagePasswordRequired({ passwordRequired, ip }) {
    if (typeof passwordRequired !== 'boolean') {
      throw new TypeError('passwordRequired must be a boolean');
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
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
      throw error;
    } finally {
      client.release();
    }
  }

  async create(page) {
    await this.pool.query(
      `
        INSERT INTO pages (
          id, html_content, created_at, password_hash, encrypted_password, is_protected,
          code_type, title, description, expires_at, markdown_theme
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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

    return { id: page.id };
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
    const search = options.search || '';
    const codeType = options.codeType || '';
    const isProtected = options.isProtected;
    const sortBy = options.sortBy || 'created_at';
    const sortOrder = options.sortOrder || 'desc';

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (search) {
      conditions.push(`(id ILIKE $${paramIndex} OR title ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex += 1;
    }

    if (codeType) {
      conditions.push(`code_type = $${paramIndex}`);
      params.push(codeType);
      paramIndex += 1;
    }

    if (isProtected !== undefined && isProtected !== '') {
      conditions.push(`is_protected = $${paramIndex}`);
      params.push(isProtected === true || isProtected === 'true' || isProtected === 1 || isProtected === 'protected' ? 1 : 0);
      paramIndex += 1;
    }

    if (options.dateFrom) {
      const fromTime = new Date(options.dateFrom).getTime();
      if (Number.isFinite(fromTime)) {
        conditions.push(`created_at >= $${paramIndex}`);
        params.push(fromTime);
        paramIndex += 1;
      }
    }

    if (options.dateTo) {
      const toTime = new Date(options.dateTo + 'T23:59:59.999').getTime();
      if (Number.isFinite(toTime)) {
        conditions.push(`created_at <= $${paramIndex}`);
        params.push(toTime);
        paramIndex += 1;
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const allowedSortColumns = { created_at: 'created_at', code_type: 'code_type', is_protected: 'is_protected' };
    const orderColumn = allowedSortColumns[sortBy] || 'created_at';
    const orderDirection = sortOrder === 'asc' ? 'ASC' : 'DESC';

    let paginationClause = '';

    if (!isUnpaginated) {
      params.push(limit, offset);
      paginationClause = `LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
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
    const search = options.search || '';
    const codeType = options.codeType || '';
    const isProtected = options.isProtected;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (search) {
      conditions.push(`(id ILIKE $${paramIndex} OR title ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex += 1;
    }

    if (codeType) {
      conditions.push(`code_type = $${paramIndex}`);
      params.push(codeType);
      paramIndex += 1;
    }

    if (isProtected !== undefined && isProtected !== '') {
      conditions.push(`is_protected = $${paramIndex}`);
      params.push(isProtected === true || isProtected === 'true' || isProtected === 1 || isProtected === 'protected' ? 1 : 0);
      paramIndex += 1;
    }

    if (options.dateFrom) {
      const fromTime = new Date(options.dateFrom).getTime();
      if (Number.isFinite(fromTime)) {
        conditions.push(`created_at >= $${paramIndex}`);
        params.push(fromTime);
        paramIndex += 1;
      }
    }

    if (options.dateTo) {
      const toTime = new Date(options.dateTo + 'T23:59:59.999').getTime();
      if (Number.isFinite(toTime)) {
        conditions.push(`created_at <= $${paramIndex}`);
        params.push(toTime);
        paramIndex += 1;
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await this.pool.query(
      `SELECT COUNT(*) AS count FROM pages ${whereClause}`,
      params
    );
    return Number.parseInt(result.rows[0]?.count || '0', 10);
  }

  async recordViewEvent(id, now = Date.now(), hasAccess = false) {
    const updateResult = await this.pool.query(
      `
        UPDATE pages
        SET view_count = COALESCE(view_count, 0) + 1
        WHERE id = $1
          AND (expires_at IS NULL OR expires_at > $2)
          AND (COALESCE(is_protected, 0) <> 1 OR $3)
        RETURNING id
      `,
      [id, now, hasAccess]
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
    const since = Date.now() - (13 * DAY_MS);
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
      recentDays: buildDailyStats(recentResult.rows),
      topViewed: topViewedResult.rows.map((row) => ({
        id: row.id,
        title: row.title || row.id,
        viewCount: Number.parseInt(row.view_count || '0', 10)
      }))
    };
  }

  async updateProtection(id, options) {
    const result = await this.pool.query(
      'UPDATE pages SET is_protected = $1, password_hash = $2, encrypted_password = $3 WHERE id = $4',
      [options.isProtected ? 1 : 0, options.passwordHash || null, options.encryptedPassword || null, id]
    );

    return result.rowCount > 0;
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
    const fields = [];
    const params = [];
    let paramIndex = 1;

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

    if (fields.length === 0) {
      return true;
    }

    params.push(id);
    const result = await this.pool.query(
      `UPDATE pages SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
      params
    );

    return result.rowCount > 0;
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
        RETURNING id, name, key_prefix, created_at, last_used_at
      `,
      [apiKey.id, apiKey.name, apiKey.keyHash, apiKey.keyPrefix, apiKey.createdAt]
    );

    return result.rows[0];
  }

  async listApiKeys() {
    const result = await this.pool.query(
      `
        SELECT id, name, key_prefix, created_at, last_used_at
        FROM api_keys
        ORDER BY created_at DESC
      `
    );

    return result.rows;
  }

  async getApiKeyById(id) {
    const result = await this.pool.query(
      'SELECT id, name, key_hash, key_prefix, created_at, last_used_at FROM api_keys WHERE id = $1 LIMIT 1',
      [id]
    );

    return result.rows[0] || null;
  }

  async deleteApiKey(id) {
    const result = await this.pool.query('DELETE FROM api_keys WHERE id = $1', [id]);
    return result.rowCount > 0;
  }

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
