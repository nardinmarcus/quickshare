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
  parseApiKeyScopes,
  toCredentialVersionString
} = require('../utils/apiKeyIdentity');
const {
  compareShareListPosition,
  grantPermissionsFromRow
} = require('../utils/shareGrants');
const {
  IdempotencyConflictError,
  requestHmacMatches
} = require('../utils/idempotency');
const { encryptSecret, generateId } = require('../utils/security');

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
    // Publish operation records (T08): `${actorNamespace}\n${requestId}`
    // -> committed operation record. Mirrors public.publish_operations.
    this.operations = new Map();
    // Per-operation promise chains serializing idempotent writes for one
    // identifier, mirroring the Postgres advisory transaction lock. The
    // chains are runtime coordination only — nothing about an in-flight
    // operation is persisted, so a crash leaves no "running" record.
    this.operationChains = new Map();
    // Immutable content snapshots (T06): share id -> Map of revision
    // decimal string -> snapshot record. Mirrors public.share_revisions.
    this.revisions = new Map();
    this.auditLogs = [];
    this.auditIdCounter = 0;
    this.apiKeys = new Map();
    // Per-Share resource grants (T12): `${apiKeyId}\n${shareId}` ->
    // grant record mirroring public.share_grants. Grants belong to the
    // logical Key ID, so rotation keeps them; deleting the Key or the
    // Share removes them in the same step.
    this.shareGrants = new Map();
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
      created_at: capturedAt,
      purged_at: null
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
        restored_from_revision: record.restored_from_revision ?? null,
        purged_at: record.purged_at ?? null
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

  // A managed-Key API write re-verifies, inside the gate (the memory
  // Adapter's write transaction), the credential version the request
  // first authenticated with (T05). The gate serializes this check
  // against rotation/delete, mirroring the Postgres row lock: if either
  // committed first, the recorded version no longer matches and the
  // write is refused instead of publishing under a revoked credential.
  recheckManagedCredential(credential) {
    if (!credential || credential.type !== 'managed') {
      return;
    }

    const apiKey = this.apiKeys.get(credential.keyId);

    if (!apiKey || !credentialVersionMatches(apiKey.credential_version, credential.credentialVersion)) {
      throw new ApiKeyCredentialChangedError();
    }
  }

  async create(page, options = {}) {
    return this.publishingGate.runWrite(async () => {
      this.recheckManagedCredential(options.apiCredential);
      return this.createUnlocked(page, options.revisionMeta, options.apiCredential);
    });
  }

  // --- Publish operation records (T08, issue #32) -------------------------
  //
  // Mirrors the Postgres implementation: one committed record per
  // (namespace, requestId), written in the same gated step as the Share,
  // its Revision 1 snapshot and the create audit. Concurrent submissions
  // of one identifier are serialized on a per-identifier promise chain
  // (the advisory-lock analogue); the Map key is the final dedup guard.

  operationKey(operation) {
    return `${operation.actorNamespace}\n${operation.requestId}`;
  }

  runOperationExclusive(operation, fn) {
    const key = this.operationKey(operation);
    const previous = this.operationChains.get(key) || Promise.resolve();
    const task = previous.then(() => fn(), () => fn());
    this.operationChains.set(key, task.catch(() => {}));

    return task;
  }

  findOperationRecord(actorNamespace, requestId) {
    return this.operations.get(`${actorNamespace}\n${requestId}`) || null;
  }

  // Replay-time availability/policy view of a committed record's result:
  // whether the Share still exists, its CURRENT access revision and
  // protection flag, and whether the result Revision snapshot payload
  // survives. A purged snapshot (T10) leaves a tombstone record behind,
  // but its payload is gone, so the version counts as cleared here.
  resultShareState(record) {
    const page = this.pages.get(record.resultShareId);

    if (!page) {
      return null;
    }

    const snapshot = this.revisions.get(record.resultShareId)?.get(record.resultRevision);

    return {
      exists: true,
      accessRevision: toAccessRevisionString(page.access_revision),
      isProtected: page.is_protected === 1,
      revisionExists: Boolean(
        snapshot && snapshot.purged_at == null && snapshot.html_content != null
      )
    };
  }

  // Returns null when the caller should proceed as a first execution;
  // throws IdempotencyConflictError for same identifier / different
  // input; otherwise returns the replay outcome for an existing record.
  resolveExistingOperation(operation) {
    const existing = this.findOperationRecord(operation.actorNamespace, operation.requestId);

    if (!existing) {
      return null;
    }

    if (!requestHmacMatches(existing.requestHmac, operation.requestHmac)) {
      throw new IdempotencyConflictError();
    }

    if (existing.resultState !== 'committed') {
      return { outcome: 'unavailable', operation: { ...existing }, shareState: null };
    }

    return {
      outcome: 'replayed',
      operation: { ...existing },
      shareState: this.resultShareState(existing)
    };
  }

  storeOperationRecord(operation, {
    resultShareId,
    resultRevision = '1',
    resultAccessRevision = '1',
    receipt
  }) {
    const record = {
      actorNamespace: operation.actorNamespace,
      requestId: operation.requestId,
      action: operation.action,
      targetId: operation.targetId ?? null,
      requestHmac: operation.requestHmac,
      resultShareId,
      resultRevision: resultRevision == null ? null : String(resultRevision),
      resultAccessRevision: resultAccessRevision == null
        ? null
        : String(resultAccessRevision),
      receiptEncrypted: receipt ? encryptSecret(JSON.stringify(receipt)) : null,
      resultState: 'committed',
      createdAt: Date.now()
    };
    this.operations.set(this.operationKey(operation), record);
    return { ...record };
  }

  // Idempotent create (T08): same contract as the Postgres Adapter.
  // `prepare()` runs only on a first execution and returns
  // { page, result }; Share, Revision 1 snapshot, create audit and the
  // operation record land together inside the gate, and same-identifier
  // submissions are serialized on the operation chain, so check and
  // insert can never interleave for one identifier.
  async createIdempotent({ operation = null, apiCredential, revisionMeta, audit, prepare }) {
    const execute = () => this.publishingGate.runWrite(async () => {
      this.recheckManagedCredential(apiCredential);

      if (operation) {
        const resolved = this.resolveExistingOperation(operation);

        if (resolved) {
          return resolved;
        }
      }

      let lastError = null;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const prepared = await prepare();

        try {
          this.createUnlocked(prepared.page, revisionMeta, apiCredential);
        } catch (error) {
          lastError = error;

          if (!String(error.message || '').includes('UNIQUE')) {
            throw error;
          }

          continue;
        }

        if (audit) {
          await this.createAuditLog({
            action: audit.action,
            pageId: prepared.page.id,
            details: audit.details,
            ip: audit.ip
          });
        }

        const record = operation
          ? this.storeOperationRecord(operation, {
            resultShareId: prepared.page.id,
            receipt: prepared.result
          })
          : null;

        return {
          outcome: 'created',
          page: prepared.page,
          result: prepared.result,
          operation: record
        };
      }

      throw lastError || new Error('Failed to create a unique page id');
    });

    return operation ? this.runOperationExclusive(operation, execute) : execute();
  }

  // Clone with optional idempotency (T08). The source is read and the
  // copy written inside one gated step; `buildClone(sourceRow)` returns
  // the copy's content fields from the stored row.
  async clonePage({ sourceId, operation = null, buildClone, audit }) {
    const execute = () => this.publishingGate.runWrite(async () => {
      if (operation) {
        const resolved = this.resolveExistingOperation(operation);

        if (resolved) {
          return resolved;
        }
      }

      const source = this.pages.get(sourceId);

      if (!source) {
        const error = new Error('Clone source not found');
        error.code = 'share_not_found';
        throw error;
      }

      const fields = buildClone(source);
      let lastError = null;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const newId = generateId();

        try {
          this.createUnlocked({
            id: newId,
            htmlContent: fields.htmlContent,
            passwordHash: null,
            encryptedPassword: null,
            isProtected: false,
            codeType: fields.codeType || 'html',
            title: fields.title || null,
            description: fields.description ?? null,
            createdAt: Date.now(),
            expiresAt: null,
            markdownTheme: fields.markdownTheme ?? null
          }, { source: 'admin-clone', actorType: 'owner' });
        } catch (error) {
          lastError = error;

          if (!String(error.message || '').includes('UNIQUE')) {
            throw error;
          }

          continue;
        }

        if (audit) {
          await this.createAuditLog({
            action: audit.action,
            pageId: newId,
            details: audit.details,
            ip: audit.ip
          });
        }

        const record = operation
          ? this.storeOperationRecord(operation, {
            resultShareId: newId,
            receipt: { kind: 'share.clone', shareId: newId }
          })
          : null;

        return { outcome: 'created', id: newId, operation: record };
      }

      throw lastError || new Error('Failed to create a unique page id');
    });

    return operation ? this.runOperationExclusive(operation, execute) : execute();
  }

  // Idempotent admin content save (T09, issue #33). The operation is
  // resolved BEFORE any version precondition is judged: a committed
  // record whose digest matches replays its original result even though
  // the request's If-Match has since gone stale, and only a first
  // execution reaches the precondition checks in updatePageUnlocked.
  // The result of a successful save — changed or unchanged — is recorded
  // in the same gated step as the projection, snapshot and audit, so the
  // record and the Revision it names commit atomically. Failed saves
  // (conflict, missing precondition, not found) record nothing, so a
  // later retry of the same identifier re-executes instead of replaying
  // a failure.
  // `apiCredential` + `grantCheck` serve the Key-authenticated content
  // update (T13, issue #37), mirroring the Postgres adapter: inside the
  // gate — this adapter's write transaction — the credential version
  // and the caller's current grant on this Share are re-verified BEFORE
  // a committed operation may replay, so a rotation, deletion or
  // revocation that committed first refuses the in-flight write, and a
  // revoked Key cannot replay its own earlier result. Dashboard
  // callers pass neither and keep T09 behavior.
  async saveContentIdempotent({ id, options, precondition = {}, operation = null, apiCredential = null, grantCheck = null }) {
    const execute = () => this.publishingGate.runWrite(async () => {
      this.recheckManagedCredential(apiCredential);

      if (grantCheck) {
        const record = this.shareGrants.get(this.grantRecordKey(grantCheck.keyId, id));
        const permissions = grantPermissionsFromRow(record);

        if (!permissions[grantCheck.permission]) {
          return {
            outcome: 'executed',
            result: {
              status: 'grant_not_found',
              accessRevision: null,
              contentRevision: null,
              contentChanged: false,
              current: null
            }
          };
        }
      }

      if (operation) {
        const resolved = this.resolveExistingOperation(operation);

        if (resolved) {
          return resolved;
        }
      }

      const result = await this.updatePageUnlocked(id, options, precondition);

      if (!operation || result.status !== 'updated') {
        return { outcome: 'executed', result };
      }

      const record = this.storeOperationRecord(operation, {
        resultShareId: id,
        resultRevision: result.contentRevision,
        resultAccessRevision: result.accessRevision,
        receipt: {
          kind: 'share.content.update',
          shareId: id,
          contentChanged: result.contentChanged === true,
          contentRevision: result.contentRevision,
          accessRevision: result.accessRevision
        }
      });

      return { outcome: 'executed', result, operation: record };
    });

    return operation ? this.runOperationExclusive(operation, execute) : execute();
  }

  // Idempotent history restore (T09, issue #33): the chosen snapshot
  // becomes the current content as a NEW Revision whose snapshot records
  // its restore source; restoring a snapshot identical to the current
  // one is a successful no-op (contentChanged: false, no new Revision)
  // that still records its operation result. Source read, current
  // version judgment, projection write, new snapshot, audit and the
  // operation record all happen in this one gated step. A restore
  // touches content fields only: URL, password, expiry, access_revision,
  // Key authorization, publish state, favorite and view count are never
  // written here. A snapshot whose payload was cleared (a purge
  // tombstone) is not a valid restore source.
  async restoreRevision({ id, sourceRevision, precondition = {}, operation = null }) {
    const execute = () => this.publishingGate.runWrite(async () => {
      if (operation) {
        const resolved = this.resolveExistingOperation(operation);

        if (resolved) {
          return resolved;
        }
      }

      const page = this.pages.get(id);

      if (!page) {
        return { outcome: 'executed', result: { status: 'not_found' } };
      }

      this.ensureContentBaseline(page);

      const source = this.revisions.get(id)?.get(toContentRevisionString(sourceRevision));

      if (!source) {
        return { outcome: 'executed', result: { status: 'source_not_found' } };
      }

      if (source.purged === true || source.purged_at != null || source.html_content == null) {
        return { outcome: 'executed', result: { status: 'source_unavailable' } };
      }

      const previousRevision = toContentRevisionString(page.current_revision);
      const result = await this.updatePageUnlocked(id, {
        htmlContent: source.html_content,
        title: source.title,
        description: source.description,
        markdownTheme: source.markdown_theme
      }, {
        ...precondition,
        expectedAccessRevision: null,
        advanceAccessRevision: false,
        contentMeta: {
          source: 'admin-restore',
          actorType: 'owner',
          actorId: null,
          restoredFromRevision: toContentRevisionString(sourceRevision)
        }
      });
      const fullResult = {
        ...result,
        sourceRevision: toContentRevisionString(sourceRevision),
        previousRevision
      };

      if (!operation || result.status !== 'updated') {
        return { outcome: 'executed', result: fullResult };
      }

      const record = this.storeOperationRecord(operation, {
        resultShareId: id,
        resultRevision: result.contentRevision,
        resultAccessRevision: result.accessRevision,
        receipt: {
          kind: 'share.restore',
          shareId: id,
          sourceRevision: toContentRevisionString(sourceRevision),
          previousRevision,
          contentRevision: result.contentRevision,
          contentChanged: result.contentChanged === true
        }
      });

      return { outcome: 'executed', result: fullResult, operation: record };
    });

    return operation ? this.runOperationExclusive(operation, execute) : execute();
  }

  // Publish-state transition (T11, issue #35): the memory counterpart
  // of the Postgres method, under the same contract. The publishing
  // gate serializes the judgment and the write; a real transition flips
  // `published` and advances the access revision together (old unlock
  // cookies die on both transitions) and writes the audit in the same
  // step, while setting the state the Share already has records the
  // operation without advancing anything. Precondition failures record
  // nothing; replay resolution precedes every judgment.
  async setPublishedState({ id, published, precondition = {}, operation = null, ip = null }) {
    const targetPublished = published === true;

    const execute = () => this.publishingGate.runWrite(async () => {
      if (operation) {
        const resolved = this.resolveExistingOperation(operation);

        if (resolved) {
          return resolved;
        }
      }

      const page = this.pages.get(id);

      if (!page) {
        return { outcome: 'executed', result: { status: 'not_found' } };
      }

      const currentAccessRevision = toAccessRevisionString(page.access_revision);
      const currentPublished = page.published !== false;
      const expected = precondition.expectedAccessRevision == null
        ? null
        : toAccessRevisionString(precondition.expectedAccessRevision);

      if (precondition.accessPreconditionMissing) {
        return {
          outcome: 'executed',
          result: { status: 'access_precondition_required', accessRevision: currentAccessRevision }
        };
      }

      if (expected === null || !accessRevisionMatches(currentAccessRevision, expected)) {
        return {
          outcome: 'executed',
          result: { status: 'conflict', accessRevision: currentAccessRevision }
        };
      }

      const changed = currentPublished !== targetPublished;
      let resultingAccessRevision = currentAccessRevision;

      if (changed) {
        page.published = targetPublished;
        page.access_revision = nextAccessRevision(currentAccessRevision);
        resultingAccessRevision = toAccessRevisionString(page.access_revision);

        await this.createAuditLog({
          action: 'page.publish.update',
          pageId: id,
          details: JSON.stringify({
            from: currentPublished,
            to: targetPublished,
            accessRevision: resultingAccessRevision
          }),
          ip
        });
      }

      const result = {
        status: changed ? 'updated' : 'unchanged',
        published: targetPublished,
        changed,
        accessRevision: resultingAccessRevision,
        contentRevision: toContentRevisionString(page.current_revision)
      };

      if (!operation) {
        return { outcome: 'executed', result };
      }

      const record = this.storeOperationRecord(operation, {
        resultShareId: id,
        resultRevision: null,
        resultAccessRevision: resultingAccessRevision,
        receipt: {
          kind: operation.action,
          shareId: id,
          published: targetPublished,
          changed,
          accessRevision: resultingAccessRevision
        }
      });

      return { outcome: 'executed', result, operation: record };
    });

    return operation ? this.runOperationExclusive(operation, execute) : execute();
  }

  // Permanent purge of one non-current Revision (T10, issue #34): the
  // memory counterpart of the Postgres method, under the same contract.
  // The publishing gate serializes the whole judgment + tombstone write
  // against saves and restores (this Adapter's Share-lock analogue), so
  // the target is re-verified as non-current with no concurrent write in
  // flight. The snapshot record keeps its metadata and gains purged_at
  // while its payload fields — body, title, description, theme and the
  // payload-derived hash — are cleared; the encrypted receipts of every
  // committed operation whose result is exactly this version are
  // scrubbed in the same step. Repeating the purge writes nothing.
  async purgeRevision({ id, revision, ip = null }) {
    const revisionString = toContentRevisionString(revision);

    if (revisionString === null) {
      return { status: 'revision_not_found', revision: null };
    }

    return this.publishingGate.runWrite(async () => {
      const page = this.pages.get(id);

      if (!page) {
        return { status: 'not_found', revision: revisionString };
      }

      const snapshot = this.revisions.get(id)?.get(revisionString);

      if (!snapshot) {
        return { status: 'revision_not_found', revision: revisionString };
      }

      if (snapshot.purged_at != null || snapshot.html_content == null) {
        return {
          status: 'already_purged',
          revision: revisionString,
          purgedAt: snapshot.purged_at ?? null
        };
      }

      if (contentRevisionMatches(page.current_revision, revisionString)) {
        return {
          status: 'current_revision',
          revision: revisionString,
          currentRevision: toContentRevisionString(page.current_revision)
        };
      }

      const purgedAt = Date.now();

      snapshot.html_content = null;
      snapshot.title = null;
      snapshot.description = null;
      snapshot.markdown_theme = null;
      snapshot.snapshot_hash = null;
      snapshot.purged_at = purgedAt;

      let scrubbedReceipts = 0;

      for (const record of this.operations.values()) {
        if (record.resultShareId === id
          && record.resultRevision === revisionString
          && record.resultState === 'committed'
          && record.receiptEncrypted) {
          record.receiptEncrypted = null;
          scrubbedReceipts += 1;
        }
      }

      await this.createAuditLog({
        action: 'page.revision.purge',
        pageId: id,
        details: JSON.stringify({ revision: revisionString, purgedAt }),
        ip
      });

      return { status: 'purged', revision: revisionString, purgedAt, scrubbedReceipts };
    });
  }

  // Operation status lookup within one credential namespace (T08). A
  // read: never gated, so operations stay confirmable during write
  // maintenance.
  async getOperation(actorNamespace, requestId) {
    const record = this.findOperationRecord(actorNamespace, requestId);
    return record ? { ...record } : null;
  }

  // Owner confirmation by request identifier across namespaces (T08).
  async getOperationByRequestId(requestId) {
    let latest = null;

    for (const record of this.operations.values()) {
      if (record.requestId === requestId
        && (!latest || record.createdAt > latest.createdAt)) {
        latest = record;
      }
    }

    return latest ? { ...latest } : null;
  }

  // Full deletion retires operation results pointing at the Share: the
  // record stays as a content-free dedup tombstone (receipt cleared,
  // result unavailable), mirroring the Postgres delete path.
  tombstoneOperationsForShares(ids) {
    const targets = new Set(ids);

    for (const record of this.operations.values()) {
      if (targets.has(record.resultShareId) && record.resultState === 'committed') {
        record.receiptEncrypted = null;
        record.resultState = 'result_unavailable';
      }
    }
  }

  async createUnlocked(page, revisionMeta = {}, apiCredential = null) {
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

    // Auto-edit grants (T13, issue #37): a managed Key whose owner
    // enabled auto_grant_new_share_edit receives read+update grants on
    // its own new Share in the same gated step as the create — never
    // publish, never for Shares that already existed. Callers that are
    // not the creating Key itself (clone, web publish) pass no
    // credential and never trigger this.
    if (apiCredential && apiCredential.type === 'managed') {
      const keyRecord = this.apiKeys.get(apiCredential.keyId);

      if (keyRecord && keyRecord.auto_grant_new_share_edit === true) {
        this.shareGrants.set(this.grantRecordKey(apiCredential.keyId, page.id), {
          api_key_id: apiCredential.keyId,
          share_id: page.id,
          can_read: true,
          can_update: true,
          can_publish: false,
          created_at: page.createdAt,
          updated_at: page.createdAt
        });
      }
    }

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
        credential_version: '1',
        // Scopes (T12): a new managed Key starts create-only, exactly
        // like a pre-T12 Key migrated by 010, and the auto-edit opt-in
        // starts at its spec default false.
        scopes: parseApiKeyScopes(apiKey.scopes),
        auto_grant_new_share_edit: apiKey.autoGrantNewShareEdit === true
      };

      this.apiKeys.set(record.id, record);
      return {
        id: record.id,
        name: record.name,
        key_prefix: record.key_prefix,
        created_at: record.created_at,
        last_used_at: record.last_used_at,
        credential_version: record.credential_version,
        scopes: [...record.scopes],
        auto_grant_new_share_edit: record.auto_grant_new_share_edit
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
        credential_version: toCredentialVersionString(record.credential_version),
        scopes: [...parseApiKeyScopes(record.scopes)],
        auto_grant_new_share_edit: record.auto_grant_new_share_edit === true
      };
    });
  }

  // Scope assignment (T12): replaces the Key's stored scope list in one
  // gated write, mirroring the Postgres adapter. Returns the public
  // record, or null when the Key does not exist.
  async updateApiKeyScopes(id, scopes) {
    return this.publishingGate.runWrite(async () => {
      const record = this.apiKeys.get(id);

      if (!record) {
        return null;
      }

      record.scopes = parseApiKeyScopes(scopes);

      return {
        id: record.id,
        name: record.name,
        key_prefix: record.key_prefix,
        created_at: record.created_at,
        last_used_at: record.last_used_at,
        credential_version: toCredentialVersionString(record.credential_version),
        scopes: [...record.scopes],
        auto_grant_new_share_edit: record.auto_grant_new_share_edit === true
      };
    });
  }

  // Auto-edit opt-in (T13): flips auto_grant_new_share_edit in one
  // gated write, mirroring the Postgres adapter. The flag is read
  // inside the create's gated step, so a toggle and a create can never
  // interleave ambiguously. Returns the public record, or null when
  // the Key does not exist.
  async updateApiKeyAutoGrant(id, enabled) {
    return this.publishingGate.runWrite(async () => {
      const record = this.apiKeys.get(id);

      if (!record) {
        return null;
      }

      record.auto_grant_new_share_edit = enabled === true;

      return {
        id: record.id,
        name: record.name,
        key_prefix: record.key_prefix,
        created_at: record.created_at,
        last_used_at: record.last_used_at,
        credential_version: toCredentialVersionString(record.credential_version),
        scopes: [...parseApiKeyScopes(record.scopes)],
        auto_grant_new_share_edit: record.auto_grant_new_share_edit === true
      };
    });
  }

  async listApiKeys() {
    return Array.from(this.apiKeys.values())
      .sort((left, right) => Number(right.created_at) - Number(left.created_at))
      .map(({ key_hash, ...apiKey }) => ({ ...apiKey, scopes: [...parseApiKeyScopes(apiKey.scopes)] }));
  }

  async getApiKeyById(id) {
    return this.apiKeys.get(id) || null;
  }

  async deleteApiKey(id) {
    return this.publishingGate.runWrite(async () => {
      const deleted = this.apiKeys.delete(id);

      if (deleted) {
        // Deleting a Key retires every grant it held in the same step
        // (T12): a deleted credential leaves no authorization behind.
        for (const [grantKey, record] of Array.from(this.shareGrants.entries())) {
          if (record.api_key_id === id) {
            this.shareGrants.delete(grantKey);
          }
        }
      }

      return deleted;
    });
  }

  // --- Per-Share grants (T12, issue #36) ----------------------------------
  //
  // Mirrors the Postgres adapter: grant/revoke are gated publishing
  // writes (the memory gate serializes writers, which is this adapter's
  // form of the Key-then-Share lock order), grants belong to the
  // logical Key ID and survive rotation, and deleting the Key or the
  // Share removes them in the same step.

  grantRecordKey(keyId, shareId) {
    return `${keyId}\n${shareId}`;
  }

  normalizeMemoryGrant(record) {
    return {
      keyId: record.api_key_id,
      shareId: record.share_id,
      permissions: grantPermissionsFromRow(record),
      createdAt: Number(record.created_at),
      updatedAt: Number(record.updated_at)
    };
  }

  async grantShareAccess({ keyId, shareId, permissions, now = Date.now() }) {
    return this.publishingGate.runWrite(async () => {
      if (!this.apiKeys.has(keyId)) {
        return { status: 'key_not_found' };
      }

      if (!this.pages.has(shareId)) {
        return { status: 'share_not_found' };
      }

      const grantKey = this.grantRecordKey(keyId, shareId);
      const existing = this.shareGrants.get(grantKey);
      const record = {
        api_key_id: keyId,
        share_id: shareId,
        can_read: permissions.read,
        can_update: permissions.update,
        can_publish: permissions.publish,
        created_at: existing ? existing.created_at : now,
        updated_at: now
      };

      this.shareGrants.set(grantKey, record);

      return {
        status: 'ok',
        created: !existing,
        grant: this.normalizeMemoryGrant(record)
      };
    });
  }

  async revokeShareAccess({ keyId, shareId }) {
    return this.publishingGate.runWrite(async () => {
      if (!this.apiKeys.has(keyId)) {
        return { status: 'key_not_found' };
      }

      const deleted = this.shareGrants.delete(this.grantRecordKey(keyId, shareId));

      if (!deleted) {
        return { status: 'grant_not_found' };
      }

      return { status: 'ok' };
    });
  }

  async listShareGrants(keyId) {
    return Array.from(this.shareGrants.values())
      .filter(record => record.api_key_id === keyId)
      .sort((left, right) => {
        if (Number(left.created_at) !== Number(right.created_at)) {
          return Number(left.created_at) - Number(right.created_at);
        }
        return left.share_id < right.share_id ? -1 : left.share_id > right.share_id ? 1 : 0;
      })
      .map(record => {
        const page = this.pages.get(record.share_id);

        return {
          ...this.normalizeMemoryGrant(record),
          shareExists: Boolean(page),
          shareTitle: page ? (page.title ?? null) : null
        };
      });
  }

  async getShareGrant(keyId, shareId) {
    const record = this.shareGrants.get(this.grantRecordKey(keyId, shareId));
    return record ? this.normalizeMemoryGrant(record) : null;
  }

  // The granted-Share list for the v1 API. Sorting and cursor filtering
  // use the SAME (created_at, id) comparison (compareShareListPosition,
  // code-unit order): mixing two orders here is exactly how a cursor
  // silently skips rows that share a timestamp.
  async listGrantedShares({ keyId, limit = 20, cursor = null } = {}) {
    const positions = [];

    for (const record of this.shareGrants.values()) {
      if (record.api_key_id !== keyId) {
        continue;
      }

      const page = this.pages.get(record.share_id);

      if (!page) {
        continue;
      }

      positions.push({ record, page, createdAt: Number(page.created_at), id: page.id });
    }

    positions.sort((left, right) => compareShareListPosition(left, right));

    const visible = cursor
      ? positions.filter(position => compareShareListPosition(position, cursor) > 0)
      : positions;
    const pageSlice = visible.slice(0, limit);
    const hasMore = visible.length > limit;
    const last = pageSlice[pageSlice.length - 1];

    return {
      shares: pageSlice.map(({ record, page }) => ({
        id: page.id,
        codeType: page.code_type || 'html',
        title: page.title ?? null,
        description: page.description ?? null,
        markdownTheme: page.markdown_theme ?? null,
        createdAt: Number(page.created_at),
        expiresAt: page.expires_at ?? null,
        isProtected: Number(page.is_protected) === 1,
        published: page.published !== false,
        contentRevision: toContentRevisionString(page.current_revision),
        accessRevision: toAccessRevisionString(page.access_revision),
        permissions: grantPermissionsFromRow(record)
      })),
      nextPosition: hasMore && last
        ? { createdAt: last.createdAt, id: last.id }
        : null
    };
  }

  // Content read for the v1 API (T12): same contract as the Postgres
  // adapter — null when no grant (or no Share), never judged by public
  // visibility.
  async getGrantedShareContent({ keyId, shareId }) {
    const record = this.shareGrants.get(this.grantRecordKey(keyId, shareId));
    const page = this.pages.get(shareId);

    if (!record || !page) {
      return null;
    }

    const currentRevision = toContentRevisionString(page.current_revision);
    const snapshot = currentRevision
      ? await this.getContentSnapshot(shareId, currentRevision)
      : null;

    return {
      permissions: grantPermissionsFromRow(record),
      shareId: page.id,
      currentRevision,
      live: {
        htmlContent: page.html_content,
        codeType: page.code_type || 'html',
        title: page.title ?? null,
        description: page.description ?? null,
        markdownTheme: page.markdown_theme ?? null
      },
      snapshot: snapshot
        ? {
            htmlContent: snapshot.html_content,
            codeType: snapshot.code_type || 'html',
            title: snapshot.title ?? null,
            description: snapshot.description ?? null,
            markdownTheme: snapshot.markdown_theme ?? null,
            purgedAt: snapshot.purged_at ?? null
          }
        : null
    };
  }

  // State read for the v1 API (T12): only the restricted state fields.
  async getGrantedShareState({ keyId, shareId }) {
    const record = this.shareGrants.get(this.grantRecordKey(keyId, shareId));
    const page = this.pages.get(shareId);

    if (!record || !page) {
      return null;
    }

    return {
      permissions: grantPermissionsFromRow(record),
      share: {
        id: page.id,
        published: page.published !== false,
        isProtected: Number(page.is_protected) === 1,
        expiresAt: page.expires_at ?? null,
        accessRevision: toAccessRevisionString(page.access_revision)
      }
    };
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
        expires_at: page.expires_at,
        published: page.published !== false,
        access_revision: toAccessRevisionString(page.access_revision)
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
    return this.publishingGate.runWrite(
      () => this.updatePageUnlocked(id, options, precondition)
    );
  }

  // The gated step of updatePageWithPreconditions, callable by callers
  // that already hold the gate (the idempotent save/restore paths, T09).
  // Two extra precondition markers serve those paths, where the caller's
  // precondition state must be judged INSIDE the transaction — after an
  // operation replay has had its chance — rather than by a route-level
  // pre-read: contentPreconditionMissing (a content save arrived without
  // its If-Match) and contentPreconditionInvalid (the tag was malformed),
  // plus accessPreconditionMissing for a combined save missing its
  // expectedAccessRevision.
  async updatePageUnlocked(id, options, precondition = {}) {
    {
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

      if (precondition.accessPreconditionMissing) {
        return {
          status: 'access_precondition_required',
          accessRevision: currentAccessRevision,
          contentRevision: toContentRevisionString(page.current_revision),
          contentChanged: false,
          current: null
        };
      }

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

      if (precondition.contentPreconditionMissing) {
        return {
          status: 'precondition_required',
          accessRevision: currentAccessRevision,
          contentRevision: currentContentRevision,
          contentChanged: false,
          current: { ...currentFields }
        };
      }

      if (precondition.contentPreconditionInvalid) {
        return {
          status: 'content_conflict',
          accessRevision: currentAccessRevision,
          contentRevision: currentContentRevision,
          contentChanged: false,
          current: { ...currentFields }
        };
      }

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
            source: (precondition.contentMeta || {}).source || 'admin-edit',
            ...((precondition.contentMeta || {}).restoredFromRevision != null
              ? { restoredFromRevision: (precondition.contentMeta || {}).restoredFromRevision }
              : {})
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
    }
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

  // Full deletion clears the Share's grants in the same step (T12,
  // parent spec #24 §3): no authorization may outlive the resource it
  // names.
  removeGrantsForShare(shareId) {
    for (const [grantKey, record] of Array.from(this.shareGrants.entries())) {
      if (record.share_id === shareId) {
        this.shareGrants.delete(grantKey);
      }
    }
  }

  async deletePage(id) {
    return this.publishingGate.runWrite(async () => {
      const deleted = this.pages.delete(id);
      if (deleted) {
        this.revisions.delete(id);
        this.removeGrantsForShare(id);
        this.tombstoneOperationsForShares([id]);
      }
      return deleted;
    });
  }

  async deletePages(ids) {
    return this.publishingGate.runWrite(async () => {
      let count = 0;
      const deletedIds = [];
      ids.forEach((id) => {
        if (this.pages.delete(id)) {
          this.revisions.delete(id);
          this.removeGrantsForShare(id);
          deletedIds.push(id);
          count += 1;
        }
      });
      this.tombstoneOperationsForShares(deletedIds);
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

        // Unpublished is indistinguishable from missing on public
        // surfaces (T11) and outranks expiry.
        if (page.published === false) {
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
