const { invalidApiKey } = require('../utils/apiKeyIdentity');
const { maintenanceError } = require('./publishing');
const { isAccessUpdate, assertAccessRevision, requireAccessRevision, accessError } = require('../utils/shareAccess');
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
    this.publishOperations = new Map();
    this.auditLogs = [];
    this.auditIdCounter = 0;
    this.apiKeys = new Map();
    this.shareGrants = new Map();
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
      // Operation records and their receipts stage the same way; a failed
      // creation must leave no dedupe record behind.
      transaction.publishOperations = structuredClone(this.publishOperations);
      transaction.apiKeys = structuredClone(this.apiKeys);
      // Grants stage too: a failed grant/revoke must leave no half-written
      // authorization behind (#24 §8 atomicity, #36).
      transaction.shareGrants = structuredClone(this.shareGrants);
      transaction.auditLogs = [];
      transaction.auditIdCounter = 0;
      transaction.homepagePasswordRequired = this.homepagePasswordRequired;
      transaction.publishingWritesPaused = this.publishingWritesPaused;
      const result = await operation(transaction);
      this.pages = transaction.pages;
      this.revisions = transaction.revisions;
      this.publishOperations = transaction.publishOperations;
      this.apiKeys = transaction.apiKeys;
      this.shareGrants = transaction.shareGrants;
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
      restored_from: row.restored_from === undefined ? null : row.restored_from,
      purged_at: row.purged_at === undefined ? null : row.purged_at
    }));
    return { items, total: String(all.length) };
  }

  /**
   * Key history API (#38): capture the current pointer and metadata page
   * synchronously from one in-memory state, with exact BIGINT cursor order.
   */
  async listContentRevisionCursorPage(shareId, { limit = 20, beforeRevision = null } = {}) {
    const parsedLimit = Math.trunc(Number(limit));
    const safeLimit = Math.min(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20, 101);
    if (beforeRevision !== null && beforeRevision !== undefined && !isContentRevision(String(beforeRevision))) {
      throw contentError(400, 'content revision cursor must be a positive decimal string');
    }
    const pageRecord = this.pages.get(shareId);
    if (!pageRecord) return { page: null, items: [] };
    const page = { id: pageRecord.id, current_revision: String(pageRecord.current_revision) };
    const revisions = this.revisions.get(shareId);
    const all = revisions ? [...revisions.values()] : [];
    const cursor = beforeRevision === null || beforeRevision === undefined ? null : BigInt(beforeRevision);
    const items = all
      .filter(row => cursor === null || BigInt(row.revision) < cursor)
      .sort((left, right) => {
        const leftValue = BigInt(left.revision);
        const rightValue = BigInt(right.revision);
        return rightValue > leftValue ? 1 : rightValue < leftValue ? -1 : 0;
      })
      .slice(0, safeLimit)
      .map(row => ({
        share_id: row.share_id,
        revision: String(row.revision),
        created_at: row.created_at,
        source: row.source,
        restored_from: row.restored_from === undefined ? null : row.restored_from,
        purged_at: row.purged_at === undefined ? null : row.purged_at
      }));
    return { page, items };
  }

  /** Capture one historical snapshot and the current pointer without an await gap. */
  async getContentRevisionWithCurrent(shareId, revision) {
    if (!isContentRevision(revision)) {
      throw contentError(400, 'content revision must be a positive decimal string');
    }
    const pageRecord = this.pages.get(shareId);
    if (!pageRecord) return null;
    const row = this.revisions.get(shareId)?.get(String(revision)) || null;
    const page = { id: pageRecord.id, current_revision: String(pageRecord.current_revision) };
    if (!row) return { page, revision: null };
    return {
      page,
      revision: {
        share_id: row.share_id,
        revision: String(row.revision),
        html_content: row.html_content,
        code_type: row.code_type,
        title: row.title,
        description: row.description,
        markdown_theme: row.markdown_theme,
        created_at: row.created_at,
        source: row.source,
        restored_from: row.restored_from === undefined ? null : row.restored_from,
        purged_at: row.purged_at === undefined ? null : row.purged_at
      }
    };
  }

  /**
   * Single bounded snapshot read for owner and Key history. Revision is
   * validated as an exact decimal before any lookup runs.
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
      last_used_at: null,
      scopes: Array.isArray(apiKey.scopes) && apiKey.scopes.length > 0 ? [...apiKey.scopes] : ['share:create'],
      auto_grant_new_share_edit: apiKey.autoGrantNewShareEdit === true
    };

    this.apiKeys.set(record.id, record);
    return {
      id: record.id,
      name: record.name,
      key_prefix: record.key_prefix,
      credential_version: record.credential_version,
      created_at: record.created_at,
      last_used_at: record.last_used_at,
      scopes: [...record.scopes],
      auto_grant_new_share_edit: record.auto_grant_new_share_edit
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

  async setApiKeyAutoGrantNewShareEdit({ apiKeyId, enabled }) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    const key = this.apiKeys.get(apiKeyId);
    if (!key) return { status: 'key-not-found' };
    if (key.auto_grant_new_share_edit === enabled) return { status: 'unchanged', enabled };
    key.auto_grant_new_share_edit = enabled;
    return { status: 'updated', enabled };
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
    return { ...receipt, scopes: [...receipt.scopes] };
  }

  async deleteApiKey(id) {
    const deleted = this.apiKeys.delete(id);
    if (deleted) {
      for (const [grantKey, grant] of this.shareGrants) {
        if (grant.api_key_id === id) this.shareGrants.delete(grantKey);
      }
    }
    return deleted;
  }

  // Per-Share read grants (#36, parent #24 §6/§8). Same Key-then-Share lock
  // order as the PostgreSQL adapter; inside a publishing transaction the
  // writes stage on the cloned Map and commit atomically. The key's
  // `share:read` scope follows its grants: first grant adds it, last revoke
  // removes it, so the scope column never advertises an unusable family.
  async grantShareRead({ apiKeyId, shareId }) {
    const key = this.apiKeys.get(apiKeyId);
    if (!key) return { status: 'key-not-found' };
    if (!this.pages.has(shareId)) return { status: 'share-not-found' };

    const mapKey = `${apiKeyId}\u0000${shareId}`;
    const existing = this.shareGrants.get(mapKey);
    if (existing) {
      if (existing.can_read) return { status: 'unchanged' };
      existing.can_read = true;
    } else {
      this.shareGrants.set(mapKey, {
        api_key_id: apiKeyId,
        share_id: shareId,
        can_read: true,
        can_update: false,
        can_publish: false,
        created_at: Date.now()
      });
    }

    if (!Array.isArray(key.scopes)) key.scopes = ['share:create'];
    if (!key.scopes.includes('share:read')) key.scopes.push('share:read');
    return { status: 'granted' };
  }

  async grantShareEdit({ apiKeyId, shareId }) {
    const key = this.apiKeys.get(apiKeyId);
    if (!key) return { status: 'key-not-found' };
    if (!this.pages.has(shareId)) return { status: 'share-not-found' };

    const mapKey = `${apiKeyId}\u0000${shareId}`;
    let grant = this.shareGrants.get(mapKey);
    const changed = !grant || grant.can_read !== true || grant.can_update !== true;
    if (!grant) {
      grant = {
        api_key_id: apiKeyId,
        share_id: shareId,
        can_read: true,
        can_update: true,
        can_publish: false,
        created_at: Date.now()
      };
      this.shareGrants.set(mapKey, grant);
    } else {
      grant.can_read = true;
      grant.can_update = true;
    }

    if (!Array.isArray(key.scopes)) key.scopes = ['share:create'];
    if (!key.scopes.includes('share:read')) key.scopes.push('share:read');
    if (!key.scopes.includes('share:update')) key.scopes.push('share:update');
    return { status: changed ? 'granted' : 'unchanged', grant: { ...grant } };
  }

  async setShareEdit({ apiKeyId, shareId, canUpdate }) {
    if (typeof canUpdate !== 'boolean') throw new TypeError('canUpdate must be a boolean');
    if (canUpdate) return this.grantShareEdit({ apiKeyId, shareId });
    const key = this.apiKeys.get(apiKeyId);
    if (!key) return { status: 'key-not-found' };
    if (!this.pages.has(shareId)) return { status: 'share-not-found' };
    const mapKey = `${apiKeyId}\u0000${shareId}`;
    const grant = this.shareGrants.get(mapKey);
    if (!grant || grant.can_update !== true) return { status: 'unchanged', grant: grant ? { ...grant } : null };
    grant.can_update = false;
    const stillHasUpdate = Array.from(this.shareGrants.values())
      .some(row => row.api_key_id === apiKeyId && row.can_update === true);
    if (!stillHasUpdate && Array.isArray(key.scopes)) {
      key.scopes = key.scopes.filter(scope => scope !== 'share:update');
    }
    return { status: 'updated', grant: { ...grant } };
  }

  async getShareGrantForWrite(apiKeyId, shareId) {
    const page = this.pages.get(shareId);
    if (!page) return null;
    const grant = await this.getShareGrant(apiKeyId, shareId);
    return { page, grant };
  }

  async revokeShareRead({ apiKeyId, shareId }) {
    const key = this.apiKeys.get(apiKeyId);
    if (!key) return { status: 'key-not-found' };

    const mapKey = `${apiKeyId}\u0000${shareId}`;
    const existing = this.shareGrants.get(mapKey);
    if (!existing || existing.can_read !== true) return { status: 'unchanged' };

    if (existing.can_update === true) return { status: 'dependent-grant' };

    if (existing.can_publish === true) {
      existing.can_read = false;
    } else {
      this.shareGrants.delete(mapKey);
    }

    const stillHasRead = Array.from(this.shareGrants.values())
      .some(grant => grant.api_key_id === apiKeyId && grant.can_read === true);
    if (!stillHasRead && Array.isArray(key.scopes)) {
      key.scopes = key.scopes.filter(scope => scope !== 'share:read');
    }
    return { status: 'revoked' };
  }

  async getShareGrant(apiKeyId, shareId) {
    const grant = this.shareGrants.get(`${apiKeyId}\u0000${shareId}`);
    return grant ? { ...grant } : null;
  }

  async listShareGrantsForKey(apiKeyId) {
    return Array.from(this.shareGrants.values())
      .filter(grant => grant.api_key_id === apiKeyId)
      .sort((left, right) =>
        Number(left.created_at) - Number(right.created_at) || left.share_id.localeCompare(right.share_id))
      .map(grant => ({
        share_id: grant.share_id,
        can_read: grant.can_read,
        can_update: grant.can_update,
        can_publish: grant.can_publish,
        created_at: grant.created_at,
        share_title: this.pages.get(grant.share_id)?.title ?? null
      }));
  }

  async listGrantedSharePage({ apiKeyId, limit, cursorCreatedAt = null, cursorId = null }) {
    // The cursor-after comparison and the ORDER BY must be the SAME
    // deterministic order (S1, #36 rework): JS code-unit comparison on both
    // sides, mirroring the PostgreSQL adapter where SQL `>` and ORDER BY
    // share one collation. localeCompare here ordered case-variant IDs
    // differently than the filter and silently dropped granted Shares.
    const byIdCodeUnit = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
    const rows = [];
    for (const grant of this.shareGrants.values()) {
      if (grant.api_key_id !== apiKeyId || grant.can_read !== true) continue;
      const page = this.pages.get(grant.share_id);
      if (!page) continue;
      if (cursorCreatedAt !== null) {
        const after = Number(page.created_at) > Number(cursorCreatedAt)
          || (Number(page.created_at) === Number(cursorCreatedAt) && byIdCodeUnit(page.id, cursorId) > 0);
        if (!after) continue;
      }
      rows.push(page);
    }
    rows.sort((left, right) =>
      Number(left.created_at) - Number(right.created_at) || byIdCodeUnit(left.id, right.id));
    return rows.slice(0, limit).map(page => ({
      id: page.id,
      created_at: page.created_at,
      code_type: page.code_type,
      title: page.title,
      description: page.description,
      markdown_theme: page.markdown_theme,
      current_revision: page.current_revision,
      access_revision: page.access_revision,
      published: page.published !== false,
      is_protected: page.is_protected,
      expires_at: page.expires_at
    }));
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
    // #35 public unification: an unpublished Share has NO public projection.
    // Null routes every public surface through the neutral missing-404 path;
    // unpublished is evaluated BEFORE expiry (expiry only classifies
    // published Shares), matching the PostgreSQL adapter exactly.
    const page = this.pages.get(id);

    if (!page || page.published === false) {
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
        expires_at: page.expires_at,
        published: page.published === false ? false : true,
        access_revision: page.access_revision
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

  /**
   * #35 owner publication transition. The access baseline is compared before
   * the single atomic state write; a same-state transition is the approved
   * unchanged no-op (no bump, no side effects). Password, expiry, content
   * revisions, history, Favorite and view counts are never touched.
   */
  async setPublished(id, options) {
    const page = this.pages.get(id);

    if (!page) {
      return null;
    }

    requireAccessRevision(options.expectedAccessRevision);
    if (String(page.access_revision) !== String(options.expectedAccessRevision)) {
      throw accessError(412, 'Share 访问设置已更改，请刷新后重新确认；未保存的输入已保留。');
    }

    const target = options.published === true;
    if (Boolean(page.published) === target) {
      return { changed: false, page };
    }

    page.published = target;
    page.access_revision = (BigInt(page.access_revision) + 1n).toString();
    return { changed: true, page };
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

  async restorePageRevision(id, options) {
    const sourceRevision = String(options.sourceRevision);
    if (!isContentRevision(sourceRevision)) {
      throw contentError(400, 'content revision must be a positive decimal string');
    }

    const page = this.pages.get(id);
    if (!page) return null;

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
      // Same-snapshot no-op: success without a new revision. This method
      // only runs inside the staged transaction whose collections replace
      // the store on commit, mirroring the PostgreSQL adapter exactly.
      return { changed: false, page: { ...page } };
    }

    page.html_content = nextContent.html_content;
    page.title = nextContent.title;
    page.description = nextContent.description;
    page.markdown_theme = nextContent.markdown_theme;
    page.current_revision = (BigInt(page.current_revision) + 1n).toString();

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
      source: options.actorSource || 'dashboard-restore',
      actor: options.actorIdentity === undefined ? 'owner-dashboard' : (options.actorIdentity || null),
      restored_from: sourceRevision
    });

    return { changed: true, page: { ...page } };
  }

  async deletePage(id) {
    const deleted = this.pages.delete(id);
    this.revisions.delete(id);
    if (deleted) {
      for (const [grantKey, grant] of this.shareGrants) {
        if (grant.share_id === id) this.shareGrants.delete(grantKey);
      }
    }
    return deleted;
  }

  // Revision purge (#34): atomically clears the payload of ONE noncurrent
  // snapshot, keeps the non-content tombstone and scrubs the sensitive
  // receipt bytes of every publish operation whose committed RESULT is this
  // exact Share+Revision (across actor namespaces). Runs inside the staged
  // publishing transaction; the current-revision recheck happens on the
  // SAME staged state, so a concurrent restore/save cannot interleave.
  async purgeContentRevision(id, revision) {
    if (!isContentRevision(revision)) {
      throw contentError(400, 'content revision must be a positive decimal string');
    }
    const normalized = String(revision);
    const page = this.pages.get(id);
    if (!page) return { found: false };

    // Current-version recheck AFTER the Share row is staged (the memory
    // publishing transaction serializes writers): the pointer at this
    // moment is authoritative, never a pre-read.
    if (String(page.current_revision) === normalized) {
      return { found: true, current: true };
    }

    const revisions = this.revisions.get(id);
    const row = revisions ? revisions.get(normalized) : null;
    if (!row) return { found: true, revision: false };

    const alreadyPurged = row.purged_at !== null && row.purged_at !== undefined;
    if (!alreadyPurged) {
      // Payload bytes go; identity, time, action, provenance, restore origin
      // and the purge moment stay. Snapshot hash is dropped: the canonical
      // digest would otherwise keep a verifiable (brute-forceable) trace of
      // the cleared title/description/theme payload.
      revisions.set(normalized, {
        ...row,
        html_content: null,
        title: null,
        description: null,
        markdown_theme: null,
        snapshot_hash: null,
        purged_at: Date.now()
      });
    }

    // Receipt scrub: ONLY records whose committed result is this exact
    // Share+Revision. Other revisions of the same Share and other Shares
    // keep their receipts; identities (result_revision) are never changed.
    const receiptPurgedAt = Date.now();
    for (const [key, record] of this.publishOperations) {
      if (record.result_share_id === id && String(record.result_revision) === normalized) {
        this.publishOperations.set(key, {
          ...record,
          receipt_encrypted: null,
          purged_at: record.purged_at === null || record.purged_at === undefined ? receiptPurgedAt : record.purged_at
        });
      }
    }

    return { found: true, current: false, revision: true, alreadyPurged, purgedAt: alreadyPurged ? row.purged_at : Date.now() };
  }

  async deletePages(ids) {
    let count = 0;
    ids.forEach((id) => {
      if (this.pages.delete(id)) count += 1;
      this.revisions.delete(id);
    });
    const deletedIds = new Set(ids);
    for (const [grantKey, grant] of this.shareGrants) {
      if (deletedIds.has(grant.share_id)) this.shareGrants.delete(grantKey);
    }
    return count;
  }

  // Publish operation records (#24 §8). The staging copy in
  // withPublishingTransaction plus the final Map guard below mirror the
  // PostgreSQL unique constraint: no half-committed or duplicate operation
  // record can exist.
  async lockPublishingOperation() {
    // The publishing queue serializes writers; no extra lock is needed.
    return true;
  }

  async findPublishingOperation(actorNamespace, requestId) {
    return this.publishOperations.get(`${actorNamespace}\u0000${requestId}`) || null;
  }

  async findPublishingOperationsByRequestId(requestId) {
    return [...this.publishOperations.values()]
      .filter(record => record.request_id === requestId)
      .sort((left, right) => Number(left.created_at) - Number(right.created_at));
  }

  async createPublishingOperation(record) {
    const key = `${record.actor_namespace}\u0000${record.request_id}`;
    if (this.publishOperations.has(key)) {
      throw Object.assign(new Error('Publishing operation already exists'), { code: '23505' });
    }
    this.publishOperations.set(key, { ...record });
    return true;
  }

  async clearPublishingOperationsForShares(shareIds) {
    if (!Array.isArray(shareIds) || shareIds.length === 0) return 0;
    const targets = new Set(shareIds);
    let cleared = 0;
    for (const [key, record] of this.publishOperations) {
      if (record.result_share_id && targets.has(record.result_share_id)) {
        this.publishOperations.set(key, {
          ...record,
          receipt_encrypted: null,
          deleted_at: record.deleted_at === null || record.deleted_at === undefined ? Date.now() : record.deleted_at
        });
        cleared += 1;
      }
    }
    return cleared;
  }

  async recordViewEvent(id, now = Date.now(), accessRevision = null) {
    const page = this.pages.get(id);

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
