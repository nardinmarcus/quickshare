const { invalidApiKey } = require('../utils/apiKeyIdentity');
const { maintenanceError } = require('./publishing');
const { isAccessUpdate, assertAccessRevision } = require('../utils/shareAccess');
const { isContentRevision, assertContentRevision, contentError, contentSnapshotHash } = require('../utils/contentRevision');
const {
  buildManagementDailyStats,
  managementDateRange
} = require('../utils/management-time');

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

function filterAdminPages(pages, options = {}) {
  const search = options.search || '';
  const codeType = options.codeType || '';
  const isProtected = options.isProtected;
  const dateFrom = options.dateFrom ? managementDateRange(options.dateFrom)?.start : null;
  const dateTo = options.dateTo ? managementDateRange(options.dateTo)?.end : null;
  let results = pages;

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

  if (options.isFavorite === true) {
    results = results.filter((page) => page.is_favorite === true);
  }

  if (dateFrom && Number.isFinite(dateFrom)) {
    results = results.filter((page) => Number(page.created_at) >= dateFrom);
  }

  if (dateTo && Number.isFinite(dateTo)) {
    results = results.filter((page) => Number(page.created_at) <= dateTo);
  }

  return results;
}

class MemoryPageRepository {
  constructor() {
    this.pages = new Map();
    this.revisions = new Map();
    this.auditLogs = [];
    this.auditIdCounter = 0;
    this.apiKeys = new Map();
    this.homepagePasswordRequired = true;
    this.publishingWritesPaused = false;
    this.publishingQueue = Promise.resolve();
  }

  async enqueuePublishing(operation) {
    const previous = this.publishingQueue;
    let release;
    this.publishingQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  async getPublishingWritesPaused() {
    if (typeof this.publishingWritesPaused !== 'boolean') throw new Error('Publishing setting is unavailable');
    return this.publishingWritesPaused;
  }

  async setPublishingWritesPaused(paused) {
    if (typeof paused !== 'boolean') throw new TypeError('paused must be a boolean');
    return this.enqueuePublishing(async () => {
      this.publishingWritesPaused = paused;
      return { publishingWritesPaused: paused };
    });
  }

  async withPublishingTransaction(operation) {
    return this.enqueuePublishing(async () => {
      // Only one publishing writer stages state at a time. Failed work never
      // restores a stale snapshot over another writer's committed state.
      const transaction = Object.create(this);
      transaction.pages = structuredClone(this.pages);
      // Revisions are cloned too: a failed transaction must not leak new
      // snapshots into the committed store through inherited references.
      transaction.revisions = structuredClone(this.revisions);
      transaction.apiKeys = structuredClone(this.apiKeys);
      transaction.auditLogs = [];
      transaction.auditIdCounter = 0;
      transaction.homepagePasswordRequired = this.homepagePasswordRequired;
      transaction.publishingWritesPaused = this.publishingWritesPaused;
      const result = await operation(transaction);
      this.pages = transaction.pages;
      this.revisions = transaction.revisions;
      this.apiKeys = transaction.apiKeys;
      this.homepagePasswordRequired = transaction.homepagePasswordRequired;
      // Login audit events may arrive independently of publishing transactions.
      for (const log of [...transaction.auditLogs].reverse()) {
        this.auditLogs.unshift({ ...log, id: ++this.auditIdCounter });
      }
      this.auditLogs = this.auditLogs.slice(0, 1000);
      return result;
    });
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

    const record = {
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
      access_revision: '1',
      current_revision: '1',
      published: true,
      view_count: 0
    };
    this.pages.set(record.id, record);
    // Baseline snapshot: same client/transaction as the materialized page.
    // Row-level provenance mirrors the PostgreSQL adapter exactly (shared
    // hash helper keeps digests identical across adapters).
    const source = page.actorSource || 'web';
    const actor = page.actorIdentity === undefined ? null : (page.actorIdentity || null);
    this.revisions.set(record.id, new Map([
      ['1', {
        share_id: record.id,
        revision: '1',
        html_content: record.html_content,
        code_type: record.code_type,
        title: record.title,
        description: record.description,
        markdown_theme: record.markdown_theme,
        created_at: record.created_at,
        snapshot_hash: contentSnapshotHash({
          htmlContent: record.html_content,
          codeType: record.code_type,
          title: record.title,
          description: record.description,
          markdownTheme: record.markdown_theme
        }),
        source,
        actor,
        restored_from: null
      }]
    ]));

    return { id: record.id };
  }

  async listContentRevisions(shareId) {
    const revisions = this.revisions.get(shareId);
    if (!revisions) return [];
    return [...revisions.values()]
      .sort((left, right) => BigInt(left.revision) - BigInt(right.revision) > 0n ? 1 : -1);
  }

  /**
   * Owner history page (#31): bounded, metadata-only page ordered by the
   * exact big-integer revision value (never Number or string order); the
   * projected items never carry the body.
   */
  async listContentRevisionPage(shareId, { limit = 20, offset = 0 } = {}) {
    const revisions = this.revisions.get(shareId);
    const all = revisions ? [...revisions.values()] : [];
    all.sort((left, right) => {
      const leftValue = BigInt(left.revision);
      const rightValue = BigInt(right.revision);
      return rightValue > leftValue ? 1 : rightValue < leftValue ? -1 : 0;
    });
    const parsedLimit = Math.trunc(Number(limit));
    const safeLimit = Math.min(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20, 100);
    const parsedOffset = Math.trunc(Number(offset));
    const safeOffset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
    const items = all.slice(safeOffset, safeOffset + safeLimit).map(row => ({
      share_id: row.share_id,
      revision: String(row.revision),
      created_at: row.created_at,
      source: row.source,
      restored_from: row.restored_from === undefined ? null : row.restored_from
    }));
    return { items, total: String(all.length) };
  }

  /**
   * Single bounded snapshot read for owner history (#31). The revision value
   * is validated as an exact decimal revision BEFORE any lookup runs.
   */
  async getContentRevision(shareId, revision) {
    if (!isContentRevision(revision)) {
      throw contentError(400, 'content revision must be a positive decimal string');
    }
    const row = this.revisions.get(shareId)?.get(String(revision));
    return row ? { ...row } : null;
  }

  async listPagesMissingBaselineRevision(limit = 200) {
    const missing = [];
    for (const page of this.pages.values()) {
      const revisions = this.revisions.get(page.id);
      if (!revisions || !revisions.has('1')) {
        missing.push({
          id: page.id,
          html_content: page.html_content,
          code_type: page.code_type,
          title: page.title,
          description: page.description,
          markdown_theme: page.markdown_theme,
          created_at: page.created_at,
          current_revision: page.current_revision
        });
      }
      if (missing.length >= limit) break;
    }
    return missing;
  }

  async listPagesNeedingTitleBackfill(limit = 200) {
    const matches = [];
    for (const page of this.pages.values()) {
      if (page.title === null || page.title === '' || page.title === page.id) {
        matches.push({
          id: page.id,
          html_content: page.html_content,
          code_type: page.code_type,
          title: page.title,
          created_at: page.created_at
        });
      }
      if (matches.length >= limit) break;
    }
    return matches;
  }

  /** Dedicated baseline-window write; only the backfill job may call this. */
  async createBaselineRevision(page) {
    let revisions = this.revisions.get(page.id);
    if (!revisions) {
      revisions = new Map();
      this.revisions.set(page.id, revisions);
    }
    if (revisions.has('1')) return false;
    revisions.set('1', {
      share_id: page.id,
      revision: '1',
      html_content: page.htmlContent,
      code_type: page.codeType || 'html',
      title: page.title || null,
      description: page.description || null,
      markdown_theme: page.markdownTheme || null,
      created_at: page.createdAt,
      snapshot_hash: contentSnapshotHash(page),
      source: 'baseline-backfill',
      actor: page.actorIdentity || 'maintenance:baseline-backfill',
      restored_from: null
    });
    return true;
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
      credential_version: '1',
      key_prefix: apiKey.keyPrefix,
      created_at: apiKey.createdAt,
      last_used_at: null
    };

    this.apiKeys.set(record.id, record);
    return {
      id: record.id,
      name: record.name,
      key_prefix: record.key_prefix,
      credential_version: record.credential_version,
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

  async verifyApiKeyForWrite(identity) {
    if (this.apiKeys.get(identity.id)?.credential_version !== identity.credentialVersion) throw invalidApiKey();
  }

  async rotateApiKey(id, keyHash) {
    const record = this.apiKeys.get(id);
    if (!record) return null;
    record.key_hash = keyHash;
    record.credential_version = (BigInt(record.credential_version) + 1n).toString();
    const { key_hash, ...receipt } = record;
    return receipt;
  }

  async deleteApiKey(id) {
    return this.apiKeys.delete(id);
  }

  async touchApiKey(id, usedAt = Date.now()) {
    if (this.publishingWritesPaused) return;
    const apiKey = this.apiKeys.get(id);

    if (apiKey) {
      apiKey.last_used_at = usedAt;
    }
  }

  async getById(id) {
    return this.pages.get(id) || null;
  }

  async getProtectionBaseline(id) {
    const page = this.pages.get(id);
    return page ? { accessRevision: page.access_revision } : null;
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
    const sortBy = options.sortBy || 'created_at';
    const sortOrder = options.sortOrder || 'desc';
    const results = filterAdminPages(Array.from(this.pages.values()), options);

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
    return filterAdminPages(Array.from(this.pages.values()), options).length;
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
      recentDays: buildManagementDailyStats(pages.map((page) => Number(page.created_at))),
      topViewed
    };
  }

  async updateProtection(id, options) {
    const page = this.pages.get(id);

    if (!page) {
      return false;
    }

    return this.updatePage(id, options);
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

    if (isAccessUpdate(options) || options.accessPrecondition) {
      assertAccessRevision(options.expectedAccessRevision, page.access_revision);
    }

    const contentSubmitted = options.htmlContent !== undefined || options.title !== undefined
      || options.description !== undefined || options.markdownTheme !== undefined;
    const contentConditional = contentSubmitted || options.contentPrecondition;
    if (contentConditional) {
      try {
        if (!isContentRevision(options.expectedContentRevision)) {
          throw contentError(options.expectedContentRevision === undefined ? 428 : 400,
            options.expectedContentRevision === undefined
              ? '请刷新 Share 后重新保存内容；未保存的输入已保留。'
              : 'content baseline must be a positive decimal string');
        }
        assertContentRevision(options.expectedContentRevision, page.current_revision);
      } catch (error) {
        if (error.code === 'CONTENT_REVISION_CONFLICT') {
          error.current = revisionConflictProjection(page);
        }
        throw error;
      }
    }

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

    if ((options.isProtected !== undefined && (options.isProtected || page.is_protected === 1)) || (options.expiresAt !== undefined && options.expiresAt !== page.expires_at) || options.revokeAccess === true) {
      page.access_revision = (BigInt(page.access_revision) + 1n).toString();
    }

    if (contentChanged) {
      page.html_content = nextContent.html_content;
      page.title = nextContent.title;
      page.description = nextContent.description;
      page.markdown_theme = nextContent.markdown_theme;
      page.current_revision = (BigInt(page.current_revision) + 1n).toString();
      // Snapshot and projection commit together: this method only runs inside
      // the staged transaction whose collections replace the store on commit.
      // Row-level provenance mirrors the PostgreSQL adapter (shared hash).
      let revisions = this.revisions.get(id);
      if (!revisions) {
        revisions = new Map();
        this.revisions.set(id, revisions);
      }
      const snapshotPayload = {
        htmlContent: nextContent.html_content,
        codeType: page.code_type || 'html',
        title: nextContent.title,
        description: nextContent.description,
        markdownTheme: nextContent.markdown_theme
      };
      revisions.set(page.current_revision, {
        share_id: id,
        revision: page.current_revision,
        html_content: nextContent.html_content,
        code_type: snapshotPayload.codeType,
        title: nextContent.title,
        description: nextContent.description,
        markdown_theme: nextContent.markdown_theme,
        created_at: Date.now(),
        snapshot_hash: contentSnapshotHash(snapshotPayload),
        source: options.actorSource || 'dashboard-edit',
        actor: options.actorIdentity === undefined ? 'owner-dashboard' : (options.actorIdentity || null),
        restored_from: null
      });
    }

    if (options.expiresAt !== undefined) {
      page.expires_at = options.expiresAt || null;
    }
    if (options.isProtected !== undefined) {
      page.is_protected = options.isProtected ? 1 : 0;
      page.password_hash = options.passwordHash || null;
      page.encrypted_password = options.encryptedPassword || null;
    }

    return options.returnUpdated ? { ...page } : true;
  }

  async deletePage(id) {
    const deleted = this.pages.delete(id);
    this.revisions.delete(id);
    return deleted;
  }

  async deletePages(ids) {
    let count = 0;
    ids.forEach((id) => {
      if (this.pages.delete(id)) count += 1;
      this.revisions.delete(id);
    });
    return count;
  }

  async recordViewEvent(id, now = Date.now(), accessRevision = null) {
    const page = this.pages.get(id);

    if (!page) {
      return 'not_found';
    }

    if (page.expires_at !== null && Number(page.expires_at) <= now) {
      return 'expired';
    }

    if (page.is_protected === 1 && accessRevision !== page.access_revision) {
      return 'protected';
    }

    if (this.publishingWritesPaused) throw maintenanceError();
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
