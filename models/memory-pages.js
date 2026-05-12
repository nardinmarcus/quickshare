class MemoryPageRepository {
  constructor() {
    this.pages = new Map();
  }

  async init() {
    return true;
  }

  async create(page) {
    if (this.pages.has(page.id)) {
      const error = new Error('UNIQUE constraint failed: pages.id');
      error.code = 'SQLITE_CONSTRAINT';
      throw error;
    }

    this.pages.set(page.id, {
      id: page.id,
      html_content: page.htmlContent,
      created_at: page.createdAt,
      password_hash: page.passwordHash || null,
      is_protected: page.isProtected ? 1 : 0,
      code_type: page.codeType || 'html',
      title: page.title || null,
      description: page.description || null,
      expires_at: page.expiresAt || null
    });

    return { id: page.id };
  }

  async getById(id) {
    return this.pages.get(id) || null;
  }

  async listRecent(limit = 10) {
    return Array.from(this.pages.values())
      .sort((left, right) => right.created_at - left.created_at)
      .slice(0, limit)
      .map((page) => ({
        id: page.id,
        created_at: page.created_at,
        code_type: page.code_type,
        title: page.title,
        description: page.description,
        is_protected: page.is_protected
      }));
  }

  async updateProtection(id, options) {
    const page = this.pages.get(id);

    if (!page) {
      return false;
    }

    page.is_protected = options.isProtected ? 1 : 0;
    page.password_hash = options.passwordHash || null;
    return true;
  }
}

module.exports = {
  MemoryPageRepository
};
