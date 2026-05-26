const DAY_MS = 24 * 60 * 60 * 1000;

function buildDailyStats(pages, days = 14) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const startAt = todayStart.getTime() - ((days - 1) * DAY_MS);
  const counts = new Map();

  for (let index = 0; index < days; index += 1) {
    const timestamp = startAt + (index * DAY_MS);
    counts.set(timestamp, 0);
  }

  pages.forEach((page) => {
    const day = new Date(Number(page.created_at));
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
      encrypted_password: page.encryptedPassword || null,
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

  async listAdminPages(options = {}) {
    const limit = Number.isInteger(options.limit) ? options.limit : 50;
    const offset = Number.isInteger(options.offset) ? options.offset : 0;
    const search = options.search || '';
    const codeType = options.codeType || '';
    const isProtected = options.isProtected;
    const sortBy = options.sortBy || 'created_at';
    const sortOrder = options.sortOrder || 'desc';

    let results = Array.from(this.pages.values());

    if (search) {
      const query = search.toLowerCase();
      results = results.filter((page) =>
        (page.id && page.id.toLowerCase().includes(query)) ||
        (page.title && page.title.toLowerCase().includes(query)) ||
        (page.description && page.description.toLowerCase().includes(query))
      );
    }

    if (codeType) {
      results = results.filter((page) => page.code_type === codeType);
    }

    if (isProtected !== undefined && isProtected !== '') {
      const target = isProtected === true || isProtected === 'true' || isProtected === 1 || isProtected === 'protected' ? 1 : 0;
      results = results.filter((page) => page.is_protected === target);
    }

    results.sort((left, right) => {
      let comparison = 0;

      if (sortBy === 'created_at') {
        comparison = Number(left.created_at) - Number(right.created_at);
      } else if (sortBy === 'code_type') {
        comparison = (left.code_type || '').localeCompare(right.code_type || '');
      } else if (sortBy === 'is_protected') {
        comparison = left.is_protected - right.is_protected;
      } else {
        comparison = Number(left.created_at) - Number(right.created_at);
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return results
      .slice(offset, offset + limit)
      .map((page) => ({
        id: page.id,
        created_at: page.created_at,
        code_type: page.code_type,
        title: page.title,
        description: page.description,
        is_protected: page.is_protected,
        encrypted_password: page.encrypted_password,
        expires_at: page.expires_at
      }));
  }

  async countPages(options = {}) {
    const search = options.search || '';
    const codeType = options.codeType || '';
    const isProtected = options.isProtected;

    let results = Array.from(this.pages.values());

    if (search) {
      const query = search.toLowerCase();
      results = results.filter((page) =>
        (page.id && page.id.toLowerCase().includes(query)) ||
        (page.title && page.title.toLowerCase().includes(query)) ||
        (page.description && page.description.toLowerCase().includes(query))
      );
    }

    if (codeType) {
      results = results.filter((page) => page.code_type === codeType);
    }

    if (isProtected !== undefined && isProtected !== '') {
      const target = isProtected === true || isProtected === 'true' || isProtected === 1 || isProtected === 'protected' ? 1 : 0;
      results = results.filter((page) => page.is_protected === target);
    }

    return results.length;
  }

  async getAdminStats() {
    const pages = Array.from(this.pages.values());
    const typeCounts = new Map();
    let protectedCount = 0;
    let latestCreatedAt = null;

    pages.forEach((page) => {
      const codeType = page.code_type || 'html';
      typeCounts.set(codeType, (typeCounts.get(codeType) || 0) + 1);

      if (page.is_protected === 1) {
        protectedCount += 1;
      }

      if (latestCreatedAt === null || Number(page.created_at) > latestCreatedAt) {
        latestCreatedAt = Number(page.created_at);
      }
    });

    return {
      total: pages.length,
      protected: protectedCount,
      public: pages.length - protectedCount,
      latestCreatedAt,
      byType: Array.from(typeCounts.entries())
        .map(([codeType, count]) => ({ codeType, count }))
        .sort((left, right) => right.count - left.count || left.codeType.localeCompare(right.codeType)),
      recentDays: buildDailyStats(pages)
    };
  }

  async updateProtection(id, options) {
    const page = this.pages.get(id);

    if (!page) {
      return false;
    }

    page.is_protected = options.isProtected ? 1 : 0;
    page.password_hash = options.passwordHash || null;
    page.encrypted_password = options.encryptedPassword || null;
    return true;
  }

  async updatePage(id, options) {
    const page = this.pages.get(id);

    if (!page) {
      return false;
    }

    if (options.title !== undefined) {
      page.title = options.title || null;
    }
    if (options.description !== undefined) {
      page.description = options.description || null;
    }
    if (options.htmlContent !== undefined) {
      page.html_content = options.htmlContent;
    }
    if (options.expiresAt !== undefined) {
      page.expires_at = options.expiresAt || null;
    }
    if (options.isProtected !== undefined) {
      page.is_protected = options.isProtected ? 1 : 0;
      page.password_hash = options.passwordHash || null;
      page.encrypted_password = options.encryptedPassword || null;
    }

    return true;
  }

  async deletePage(id) {
    return this.pages.delete(id);
  }
}

module.exports = {
  MemoryPageRepository
};
