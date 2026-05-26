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
        expires_at BIGINT
      )
    `);

    await this.pool.query('CREATE INDEX IF NOT EXISTS idx_pages_created_at ON pages (created_at DESC)');
    await this.pool.query('ALTER TABLE pages ADD COLUMN IF NOT EXISTS encrypted_password TEXT');
  }

  async create(page) {
    await this.pool.query(
      `
        INSERT INTO pages (
          id, html_content, created_at, password_hash, encrypted_password, is_protected,
          code_type, title, description, expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
        page.expiresAt || null
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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const allowedSortColumns = { created_at: 'created_at', code_type: 'code_type', is_protected: 'is_protected' };
    const orderColumn = allowedSortColumns[sortBy] || 'created_at';
    const orderDirection = sortOrder === 'asc' ? 'ASC' : 'DESC';

    params.push(limit, offset);

    const result = await this.pool.query(
      `
        SELECT id, created_at, code_type, title, description, is_protected, encrypted_password, expires_at
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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await this.pool.query(
      `SELECT COUNT(*) AS count FROM pages ${whereClause}`,
      params
    );
    return Number.parseInt(result.rows[0]?.count || '0', 10);
  }

  async getAdminStats() {
    const since = Date.now() - (13 * DAY_MS);
    const [summaryResult, typeResult, recentResult] = await Promise.all([
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
      )
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
      recentDays: buildDailyStats(recentResult.rows)
    };
  }

  async updateProtection(id, options) {
    const result = await this.pool.query(
      'UPDATE pages SET is_protected = $1, password_hash = $2, encrypted_password = $3 WHERE id = $4',
      [options.isProtected ? 1 : 0, options.passwordHash || null, options.encryptedPassword || null, id]
    );

    return result.rowCount > 0;
  }

  async deletePage(id) {
    const result = await this.pool.query('DELETE FROM pages WHERE id = $1', [id]);
    return result.rowCount > 0;
  }
}

module.exports = {
  PostgresPageRepository
};
