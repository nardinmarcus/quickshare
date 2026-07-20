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
    this.auditLogs = [];
    this.auditIdCounter = 0;
    this.apiKeys = new Map();
    this.homepagePasswordRequired = true;
  }

  async init() {
    return true;
  }

  async getHomepagePasswordRequired() {
    if (typeof this.homepagePasswordRequired !== 'boolean') {
      throw new Error('Homepage access setting is unavailable');
    }

    return this.homepagePasswordRequired;
  }

  async setHomepagePasswordRequired({ passwordRequired, ip }) {
    if (typeof passwordRequired !== 'boolean') {
      throw new TypeError('passwordRequired must be a boolean');
    }

    const previousValue = this.homepagePasswordRequired;

    if (typeof previousValue !== 'boolean') {
      throw new Error('Homepage access setting is unavailable');
    }

    if (previousValue === passwordRequired) {
      return { passwordRequired, changed: false };
    }

    await this.createAuditLog({
      action: 'settings.homepage_password_required.update',
      pageId: null,
      details: JSON.stringify({ from: previousValue, to: passwordRequired }),
      ip
    });
    this.homepagePasswordRequired = passwordRequired;

    return { passwordRequired, changed: true };
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
      expires_at: page.expiresAt || null,
      markdown_theme: page.markdownTheme || null,
      is_favorite: false,
      view_count: 0
    });

    return { id: page.id };
  }

  async createApiKey(apiKey) {
    if (this.apiKeys.has(apiKey.id)) {
      const error = new Error('UNIQUE constraint failed: api_keys.id');
      error.code = 'SQLITE_CONSTRAINT';
      throw error;
    }

    const record = {
      id: apiKey.id,
      name: apiKey.name,
      key_hash: apiKey.keyHash,
      key_prefix: apiKey.keyPrefix,
      created_at: apiKey.createdAt,
      last_used_at: null
    };

    this.apiKeys.set(record.id, record);
    return {
      id: record.id,
      name: record.name,
      key_prefix: record.key_prefix,
      created_at: record.created_at,
      last_used_at: record.last_used_at
    };
  }

  async listApiKeys() {
    return Array.from(this.apiKeys.values())
      .sort((left, right) => Number(right.created_at) - Number(left.created_at))
      .map(({ key_hash, ...apiKey }) => ({ ...apiKey }));
  }

  async getApiKeyById(id) {
    return this.apiKeys.get(id) || null;
  }

  async deleteApiKey(id) {
    return this.apiKeys.delete(id);
  }

  async touchApiKey(id, usedAt = Date.now()) {
    const apiKey = this.apiKeys.get(id);

    if (apiKey) {
      apiKey.last_used_at = usedAt;
    }
  }

  async getById(id) {
    return this.pages.get(id) || null;
  }

  async getPublicById(id, now = Date.now()) {
    const page = this.pages.get(id);

    if (!page) {
      return null;
    }

    const publicPage = { ...page };
    delete publicPage.is_favorite;

    return {
      page: publicPage,
      expired: page.expires_at !== null && Number(page.expires_at) <= now
    };
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
    const isUnpaginated = options.limit === null;
    const limit = Number.isInteger(options.limit) ? options.limit : 50;
    const offset = Number.isInteger(options.offset) ? options.offset : 0;
    const search = options.search || '';
    const codeType = options.codeType || '';
    const isProtected = options.isProtected;
    const sortBy = options.sortBy || 'created_at';
    const sortOrder = options.sortOrder || 'desc';
    const dateFrom = options.dateFrom ? new Date(options.dateFrom).getTime() : null;
    const dateTo = options.dateTo ? new Date(options.dateTo + 'T23:59:59.999').getTime() : null;

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

    if (dateFrom && Number.isFinite(dateFrom)) {
      results = results.filter((page) => Number(page.created_at) >= dateFrom);
    }
    if (dateTo && Number.isFinite(dateTo)) {
      results = results.filter((page) => Number(page.created_at) <= dateTo);
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

    const visibleResults = isUnpaginated ? results : results.slice(offset, offset + limit);

    return visibleResults
      .map((page) => ({
        id: page.id,
        created_at: page.created_at,
        code_type: page.code_type,
        title: page.title,
        description: page.description,
        is_protected: page.is_protected,
        is_favorite: page.is_favorite,
        encrypted_password: page.encrypted_password,
        expires_at: page.expires_at
      }));
  }

  async countPages(options = {}) {
    const search = options.search || '';
    const codeType = options.codeType || '';
    const isProtected = options.isProtected;
    const dateFrom = options.dateFrom ? new Date(options.dateFrom).getTime() : null;
    const dateTo = options.dateTo ? new Date(options.dateTo + 'T23:59:59.999').getTime() : null;

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

    if (dateFrom && Number.isFinite(dateFrom)) {
      results = results.filter((page) => Number(page.created_at) >= dateFrom);
    }
    if (dateTo && Number.isFinite(dateTo)) {
      results = results.filter((page) => Number(page.created_at) <= dateTo);
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

    const topViewed = pages
      .filter((p) => (p.view_count || 0) > 0)
      .sort((a, b) => (b.view_count || 0) - (a.view_count || 0))
      .slice(0, 10)
      .map((p) => ({
        id: p.id,
        title: p.title || p.id,
        viewCount: p.view_count || 0
      }));

    return {
      total: pages.length,
      protected: protectedCount,
      public: pages.length - protectedCount,
      latestCreatedAt,
      byType: Array.from(typeCounts.entries())
        .map(([codeType, count]) => ({ codeType, count }))
        .sort((left, right) => right.count - left.count || left.codeType.localeCompare(right.codeType)),
      recentDays: buildDailyStats(pages),
      topViewed
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

  async setFavorite(id, isFavorite) {
    if (typeof isFavorite !== 'boolean') {
      throw new TypeError('isFavorite must be a boolean');
    }

    const page = this.pages.get(id);

    if (!page) {
      return {
        found: false,
        changed: false,
        isFavorite: false,
        previousValue: null
      };
    }

    const previousValue = page.is_favorite;

    page.is_favorite = isFavorite;

    return {
      found: true,
      changed: previousValue !== isFavorite,
      isFavorite,
      previousValue
    };
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
    if (options.markdownTheme !== undefined) {
      page.markdown_theme = options.markdownTheme || null;
    }

    return true;
  }

  async deletePage(id) {
    return this.pages.delete(id);
  }

  async deletePages(ids) {
    let count = 0;
    ids.forEach((id) => {
      if (this.pages.delete(id)) count += 1;
    });
    return count;
  }

  async recordViewEvent(id, now = Date.now(), hasAccess = false) {
    const page = this.pages.get(id);

    if (!page) {
      return 'not_found';
    }

    if (page.expires_at !== null && Number(page.expires_at) <= now) {
      return 'expired';
    }

    if (page.is_protected === 1 && !hasAccess) {
      return 'protected';
    }

    page.view_count = (page.view_count || 0) + 1;
    return 'counted';
  }

  async createAuditLog({ action, pageId, details, ip }) {
    this.auditIdCounter += 1;
    this.auditLogs.unshift({
      id: this.auditIdCounter,
      action,
      pageId: pageId || null,
      details: details || null,
      ip: ip || null,
      createdAt: Date.now()
    });
    if (this.auditLogs.length > 1000) {
      this.auditLogs = this.auditLogs.slice(0, 1000);
    }
  }

  async listAuditLogs(options = {}) {
    const limit = Math.min(options.limit || 50, 200);
    const offset = options.offset || 0;
    return this.auditLogs.slice(offset, offset + limit).map((log) => ({
      id: log.id,
      action: log.action,
      pageId: log.pageId,
      details: log.details,
      ip: log.ip,
      createdAt: log.createdAt
    }));
  }

  async countAuditLogs() {
    return this.auditLogs.length;
  }
}

module.exports = {
  MemoryPageRepository
};
