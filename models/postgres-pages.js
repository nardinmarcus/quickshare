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
        is_protected INTEGER DEFAULT 0,
        code_type TEXT DEFAULT 'html',
        title TEXT,
        description TEXT,
        expires_at BIGINT
      )
    `);

    await this.pool.query('CREATE INDEX IF NOT EXISTS idx_pages_created_at ON pages (created_at DESC)');
  }

  async create(page) {
    await this.pool.query(
      `
        INSERT INTO pages (
          id, html_content, created_at, password_hash, is_protected,
          code_type, title, description, expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        page.id,
        page.htmlContent,
        page.createdAt,
        page.passwordHash || null,
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

  async updateProtection(id, options) {
    const result = await this.pool.query(
      'UPDATE pages SET is_protected = $1, password_hash = $2 WHERE id = $3',
      [options.isProtected ? 1 : 0, options.passwordHash || null, id]
    );

    return result.rowCount > 0;
  }
}

module.exports = {
  PostgresPageRepository
};
