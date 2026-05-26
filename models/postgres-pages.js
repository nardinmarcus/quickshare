const DAY_MS = 24 * 60 * 60 * 1000;

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
  constructor(connectionString) {
    if (!connectionString) {
      throw new Error('DATABASE_URL is required for PostgresPageRepository');
    }

    const { Pool } = require('pg');

    this.pool = new Pool({
      connectionString,
      ssl: process.env.POSTGRES_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: Number.parseInt(process.env.POSTGRES_POOL_MAX || '3', 10)
    });
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        html_content TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        password_hash TEXT,
        encrypted_password TEXT,
        is_protected INTEGER DEFAULT 0,
        code_type TEXT DEFAULT 'html',
        title TEXT,
        description TEXT,
        expires_at BIGINT,
        markdown_theme TEXT
      )
    `);

    await this.pool.query('CREATE INDEX IF NOT EXISTS idx_pages_created_at ON pages (created_at DESC)');
    await this.pool.query('ALTER TABLE pages ADD COLUMN IF NOT EXISTS encrypted_password TEXT');
    await this.pool.query('ALTER TABLE pages ADD COLUMN IF NOT EXISTS markdown_theme TEXT');
    await this.pool.query('ALTER TABLE pages ADD COLUMN IF NOT EXISTS view_count BIGINT DEFAULT 0');
    await this.pool.query('CREATE INDEX IF NOT EXISTS idx_pages_view_count ON pages (view_count DESC)');

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        page_id TEXT,
        details TEXT,
        ip TEXT,
        created_at BIGINT NOT NULL
      )
    `);
    await this.pool.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC)');
    await this.pool.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_page_id ON audit_logs (page_id)');
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

    params.push(limit, offset);

    const result = await this.pool.query(
      `
        SELECT id, created_at, code_type, title, description, is_protected, encrypted_password, expires_at, COALESCE(view_count, 0) AS view_count
        FROM pages
        ${whereClause}
        ORDER BY ${orderColumn} ${orderDirection}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
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

  async incrementViewCount(id) {
    await this.pool.query(
      'UPDATE pages SET view_count = COALESCE(view_count, 0) + 1 WHERE id = $1',
      [id]
    );
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
