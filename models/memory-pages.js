const {
  buildManagementDailyStats,
  managementDateRange
} = require('../utils/management-time');
const {
  accessRevisionMatches,
  nextAccessRevision,
  toAccessRevisionString
} = require('../utils/shareAccess');
const {
  PUBLISHING_PAUSED_AUDIT_ACTION,
  MemoryPublishingGate,
  isPublishingPausedError
} = require('../utils/publishing');
const {
  computeSnapshotHash,
  contentRevisionMatches,
  contentSnapshotsEqual,
  nextContentRevision,
  snapshotPayloadOf,
  toContentRevisionString
} = require('../utils/contentRevision');
const {
  ApiKeyCredentialChangedError,
  credentialVersionMatches,
  nextCredentialVersion,
  toCredentialVersionString
} = require('../utils/apiKeyIdentity');

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

// The content fields that make up a Revision snapshot (T06). Everything
// else on a page row — protection, expiry, favorite, view count — is
// access/runtime state and never enters content history.
function currentContentFields(page) {
  return {
    htmlContent: page.html_content,
    codeType: page.code_type || 'html',
    title: page.title ?? null,
    description: page.description ?? null,
    markdownTheme: page.markdown_theme ?? null
  };
}

class MemoryPageRepository {
  constructor() {
    this.pages = new Map();
    // Immutable content snapshots (T06): share id -> Map of revision
    // decimal string -> snapshot record. Mirrors public.share_revisions.
    this.revisions = new Map();
    this.auditLogs = [];
    this.auditIdCounter = 0;
    this.apiKeys = new Map();
    this.homepagePasswordRequired = true;
    // Same observable maintenance-gate protocol as the Postgres advisory
    // lock (T04): shared holds for writes, exclusive drain for pausing.
    this.publishingGate = new MemoryPublishingGate();
  }

  // Writes one immutable snapshot for the page's current materialized
  // fields. The capture time is supplied by the caller: creation time for
  // a create, edit time for an edit, and the backfill run's own time for
  // a baseline — never silently the Share's original creation time when
  // the snapshot is taken later.
  writeContentSnapshot(page, revision, meta = {}, capturedAt = Date.now()) {
    const revisionString = toContentRevisionString(revision);
    const fields = currentContentFields(page);
    const record = {
      share_id: page.id,
      revision: revisionString,
      html_content: fields.htmlContent,
      code_type: fields.codeType,
      title: fields.title,
      description: fields.description,
      markdown_theme: fields.markdownTheme,
      snapshot_hash: computeSnapshotHash(page.id, revisionString, fields),
      source: meta.source || 'admin-edit',
      actor_type: meta.actorType || 'owner',
      actor_id: meta.actorId ?? null,
      restored_from_revision: meta.restoredFromRevision ?? null,
      created_at: capturedAt
    };

    if (!this.revisions.has(page.id)) {
      this.revisions.set(page.id, new Map());
    }
    this.revisions.get(page.id).set(revisionString, record);
    return record;
  }

  // Establishes the Revision 1 baseline for a Share that predates the
  // revision protocol (current_revision still null), capturing its
  // current materialized fields exactly as they are. Returns true when a
  // baseline was written.
  ensureContentBaseline(page, capturedAt = Date.now()) {
    if (toContentRevisionString(page.current_revision) !== null) {
      return false;
    }

    page.current_revision = '1';
    this.writeContentSnapshot(page, '1', {
      source: 'baseline',
      actorType: 'operator'
    }, capturedAt);
    return true;
  }

  async getContentSnapshot(id, revision) {
    const byRevision = this.revisions.get(id);
    const record = byRevision?.get(toContentRevisionString(revision));
    return record ? { ...record } : null;
  }

  async listContentSnapshots(id) {
    const byRevision = this.revisions.get(id);

    if (!byRevision) {
      return [];
    }

    return Array.from(byRevision.values())
      .sort((left, right) => (BigInt(left.revision) < BigInt(right.revision) ? -1 : 1))
      .map(record => ({ ...record }));
  }

  // Paginated history metadata for the admin history browser (T07,
  // issue #31). Newest Revision first; the page contains metadata only —
  // version, capture time, operation source and restore provenance — and
  // never the snapshot body, so listing history cannot become an
  // unbounded content aggregation. Revision numbers stay decimal strings
  // end to end (no Number conversion, no BIGINT rounding).
  async listContentRevisionMeta(id, { limit = 20, offset = 0 } = {}) {
    const byRevision = this.revisions.get(id);

    if (!byRevision) {
      return { total: 0, revisions: [] };
    }

    const sorted = Array.from(byRevision.values())
      .sort((left, right) => (BigInt(left.revision) < BigInt(right.revision) ? 1 : -1));

    return {
      total: sorted.length,
      revisions: sorted.slice(offset, offset + limit).map(record => ({
        revision: record.revision,
        created_at: record.created_at,
        source: record.source,
        actor_type: record.actor_type,
        restored_from_revision: record.restored_from_revision ?? null
      }))
    };
  }

  // The baseline DML of the parent spec's rollout (issue #24 §11 step 4),
  // for this Adapter: every Share without a baseline gains Revision 1
  // capturing its current fields, with the capture time of THIS run. A
  // second run skips everything. The Postgres operator script enforces
  // the surrounding write-maintenance window; this method is the DML.
  async backfillRevisionBaselines({ now = Date.now() } = {}) {
    let baselined = 0;
    let skipped = 0;

    for (const page of this.pages.values()) {
      if (this.ensureContentBaseline(page, now)) {
        baselined += 1;
      } else {
        skipped += 1;
      }
    }

    return { baselined, skipped };
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

    // A management write: it passes the publishing maintenance gate (T04).
    return this.publishingGate.runWrite(async () => {
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
    });
  }

  async getPublishingWritesPaused() {
    return this.publishingGate.isPaused();
  }

  async setPublishingWritesPaused({ paused, ip } = {}) {
    if (typeof paused !== 'boolean') {
      throw new TypeError('paused must be a boolean');
    }

    return this.publishingGate.setPaused(paused, async (previousValue, nextValue) => {
      await this.createAuditLog({
        action: PUBLISHING_PAUSED_AUDIT_ACTION,
        pageId: null,
        details: JSON.stringify({ from: previousValue, to: nextValue }),
        ip
      });
    });
  }

  async create(page, options = {}) {
    return this.publishingGate.runWrite(async () => {
      // A managed-Key API write re-verifies, inside the gate (the memory
      // Adapter's write transaction), the credential version the request
      // first authenticated with (T05). The gate serializes this check
      // against rotation/delete, mirroring the Postgres row lock: if either
      // committed first, the recorded version no longer matches and the
      // write is refused instead of publishing under a revoked credential.
      const credential = options.apiCredential;

      if (credential && credential.type === 'managed') {
        const apiKey = this.apiKeys.get(credential.keyId);

        if (!apiKey || !credentialVersionMatches(apiKey.credential_version, credential.credentialVersion)) {
          throw new ApiKeyCredentialChangedError();
        }
      }

      return this.createUnlocked(page, options.revisionMeta);
    });
  }

  async createUnlocked(page, revisionMeta = {}) {
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
      access_revision: '1',
      // Content Revision baseline (T06): creation writes Revision 1 and
      // its immutable snapshot in the same step as the Share itself, and
      // the Share starts published.
      current_revision: '1',
      published: true,
      is_favorite: false,
      view_count: 0
    };

    this.pages.set(page.id, record);
    this.writeContentSnapshot(record, '1', {
      source: revisionMeta.source || 'web-create',
      actorType: revisionMeta.actorType || 'owner',
      actorId: revisionMeta.actorId ?? null
    }, page.createdAt);

    return { id: page.id };
  }

  async createApiKey(apiKey) {
    return this.publishingGate.runWrite(async () => {
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
        last_used_at: null,
        credential_version: '1'
      };

      this.apiKeys.set(record.id, record);
      return {
        id: record.id,
        name: record.name,
        key_prefix: record.key_prefix,
        created_at: record.created_at,
        last_used_at: record.last_used_at,
        credential_version: record.credential_version
      };
    });
  }

  // Rotation (T05): keeps the logical Key ID, name and creation time,
  // replaces the secret hash/prefix and advances the credential version, so
  // every previously issued secret stops working the moment this commits.
  // Runs through the publishing gate like every other Key management write.
  // Returns the public record (never the hash), or null when missing.
  async rotateApiKey(id, { keyHash, keyPrefix } = {}) {
    return this.publishingGate.runWrite(async () => {
      const record = this.apiKeys.get(id);

      if (!record) {
        return null;
      }

      record.key_hash = keyHash;
      record.key_prefix = keyPrefix;
      record.credential_version = nextCredentialVersion(record.credential_version);

      return {
        id: record.id,
        name: record.name,
        key_prefix: record.key_prefix,
        created_at: record.created_at,
        last_used_at: record.last_used_at,
        credential_version: toCredentialVersionString(record.credential_version)
      };
    });
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
    return this.publishingGate.runWrite(async () => this.apiKeys.delete(id));
  }

  // Deliberately NOT gated (T04): background last-used bookkeeping for an
  // already-authorized read must not impede read access during maintenance.
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
    return this.publishingGate.runWrite(async () => {
      const page = this.pages.get(id);

      if (!page) {
        return false;
      }

      page.is_protected = options.isProtected ? 1 : 0;
      page.password_hash = options.passwordHash || null;
      page.encrypted_password = options.encryptedPassword || null;
      // A protection write is an access-policy change: previously issued
      // access cookies must stop working immediately (T01).
      page.access_revision = nextAccessRevision(page.access_revision);
      return true;
    });
  }

  // Conditional protection write used by the access-policy routes (T01).
  // The update only applies when the stored revision still equals
  // expectedAccessRevision; the revision advances in the same step when
  // advanceAccessRevision is set, so the check and the revocation are atomic.
  async updateProtectionWithAccessRevision(id, options, precondition = {}) {
    return this.publishingGate.runWrite(async () => {
      const page = this.pages.get(id);

      if (!page) {
        return { status: 'not_found', accessRevision: null };
      }

      const currentRevision = toAccessRevisionString(page.access_revision);

      if (precondition.expectedAccessRevision != null
        && !accessRevisionMatches(currentRevision, precondition.expectedAccessRevision)) {
        return { status: 'conflict', accessRevision: currentRevision };
      }

      page.is_protected = options.isProtected ? 1 : 0;
      page.password_hash = options.passwordHash || null;
      page.encrypted_password = options.encryptedPassword || null;

      if (precondition.advanceAccessRevision) {
        page.access_revision = nextAccessRevision(currentRevision);
      }

      return { status: 'updated', accessRevision: toAccessRevisionString(page.access_revision) };
    });
  }

  // The one admin content/access write path (T01 + T06). Two independent
  // precondition families are enforced in the same gated step, and a
  // combined save commits only when both pass:
  //   - access family (T01): expectedAccessRevision compare-and-swap;
  //     advanceAccessRevision moves it when the policy actually changed.
  //   - content family (T06): expectedContentRevision compare-and-swap
  //     against current_revision. When the merged candidate snapshot
  //     differs byte-exactly from the current one, the materialized
  //     projection, the new current_revision and an immutable snapshot
  //     (plus its audit record) are written together; an unchanged
  //     candidate writes nothing and reports contentChanged: false.
  // Callers that pass no content precondition (internal legacy writes)
  // still cannot bypass Revision: their content changes snapshot too.
  async updatePageWithPreconditions(id, options, precondition = {}) {
    return this.publishingGate.runWrite(async () => {
      const page = this.pages.get(id);

      if (!page) {
        return {
          status: 'not_found',
          accessRevision: null,
          contentRevision: null,
          contentChanged: false,
          current: null
        };
      }

      this.ensureContentBaseline(page);

      const currentAccessRevision = toAccessRevisionString(page.access_revision);

      if (precondition.expectedAccessRevision != null
        && !accessRevisionMatches(currentAccessRevision, precondition.expectedAccessRevision)) {
        return {
          status: 'conflict',
          accessRevision: currentAccessRevision,
          contentRevision: toContentRevisionString(page.current_revision),
          contentChanged: false,
          current: null
        };
      }

      const currentFields = currentContentFields(page);
      const candidate = {
        htmlContent: options.htmlContent !== undefined ? options.htmlContent : currentFields.htmlContent,
        codeType: currentFields.codeType,
        title: options.title !== undefined ? (options.title || null) : currentFields.title,
        description: options.description !== undefined ? (options.description || null) : currentFields.description,
        markdownTheme: options.markdownTheme !== undefined ? (options.markdownTheme || null) : currentFields.markdownTheme
      };
      const currentContentRevision = toContentRevisionString(page.current_revision);

      if (precondition.expectedContentRevision != null
        && !contentRevisionMatches(currentContentRevision, precondition.expectedContentRevision)) {
        return {
          status: 'content_conflict',
          accessRevision: currentAccessRevision,
          contentRevision: currentContentRevision,
          contentChanged: false,
          current: { ...currentFields }
        };
      }

      const contentChanged = !contentSnapshotsEqual(candidate, currentFields);

      if (options.expiresAt !== undefined) {
        page.expires_at = options.expiresAt || null;
      }

      if (options.isProtected !== undefined) {
        page.is_protected = options.isProtected ? 1 : 0;
        page.password_hash = options.passwordHash || null;
        page.encrypted_password = options.encryptedPassword || null;
      }

      if (contentChanged) {
        page.html_content = candidate.htmlContent;
        page.title = candidate.title;
        page.description = candidate.description;
        page.markdown_theme = candidate.markdownTheme;
        page.current_revision = nextContentRevision(currentContentRevision);
        this.writeContentSnapshot(page, page.current_revision, precondition.contentMeta || {});
        await this.createAuditLog({
          action: 'page.content.update',
          pageId: id,
          details: JSON.stringify({
            fromRevision: currentContentRevision,
            toRevision: page.current_revision,
            source: (precondition.contentMeta || {}).source || 'admin-edit'
          }),
          ip: precondition.ip || null
        });
      }

      if (precondition.advanceAccessRevision) {
        page.access_revision = nextAccessRevision(currentAccessRevision);
      }

      return {
        status: 'updated',
        accessRevision: toAccessRevisionString(page.access_revision),
        contentRevision: toContentRevisionString(page.current_revision),
        contentChanged,
        current: null
      };
    });
  }

  // Admin save that may combine content fields with access-policy fields
  // (T01). Kept for the pre-T06 call shape; it delegates to the unified
  // path so its content changes also produce Revisions (no bypass).
  async updatePageWithAccessPolicy(id, options, precondition = {}) {
    return this.updatePageWithPreconditions(id, options, {
      ...precondition,
      expectedContentRevision: null,
      contentMeta: { source: 'admin-edit', actorType: 'owner' }
    });
  }

  // Explicit admin revocation entry (T01): advances the access revision
  // without touching the password, expiry, or content.
  async revokeAccess(id, expectedAccessRevision) {
    return this.publishingGate.runWrite(async () => {
      const page = this.pages.get(id);

      if (!page) {
        return { status: 'not_found', accessRevision: null };
      }

      const currentRevision = toAccessRevisionString(page.access_revision);

      if (expectedAccessRevision != null
        && !accessRevisionMatches(currentRevision, expectedAccessRevision)) {
        return { status: 'conflict', accessRevision: currentRevision };
      }

      page.access_revision = nextAccessRevision(currentRevision);

      return { status: 'updated', accessRevision: toAccessRevisionString(page.access_revision) };
    });
  }

  async setFavorite(id, isFavorite) {
    if (typeof isFavorite !== 'boolean') {
      throw new TypeError('isFavorite must be a boolean');
    }

    return this.publishingGate.runWrite(async () => {
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
    });
  }

  // Legacy unconditional write entry. It delegates to the unified path
  // (T06) so even a caller without preconditions cannot change content
  // without producing a Revision snapshot.
  async updatePage(id, options) {
    const result = await this.updatePageWithPreconditions(id, options, {
      contentMeta: { source: 'legacy-update', actorType: 'owner' }
    });
    return result.status === 'updated';
  }

  async deletePage(id) {
    return this.publishingGate.runWrite(async () => {
      const deleted = this.pages.delete(id);
      if (deleted) {
        this.revisions.delete(id);
      }
      return deleted;
    });
  }

  async deletePages(ids) {
    return this.publishingGate.runWrite(async () => {
      let count = 0;
      ids.forEach((id) => {
        if (this.pages.delete(id)) {
          this.revisions.delete(id);
          count += 1;
        }
      });
      return count;
    });
  }

  async recordViewEvent(id, now = Date.now(), hasAccess = false, accessRevision = null) {
    // A view event is a controlled write: while publishing writes are
    // paused it is not counted at all and reports 'maintenance' (T04).
    try {
      return await this.publishingGate.runWrite(async () => {
        const page = this.pages.get(id);

        if (!page) {
          return 'not_found';
        }

        if (page.expires_at !== null && Number(page.expires_at) <= now) {
          return 'expired';
        }

        // A protected Share only counts the event when the caller's credential
        // is bound to the Share's current access revision (T01). A boolean
        // "has access" without a matching revision is not enough.
        if (page.is_protected === 1
          && (!hasAccess || accessRevision == null
            || !accessRevisionMatches(page.access_revision, accessRevision))) {
          return 'protected';
        }

        page.view_count = (page.view_count || 0) + 1;
        return 'counted';
      });
    } catch (error) {
      if (isPublishingPausedError(error)) {
        return 'maintenance';
      }

      throw error;
    }
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
