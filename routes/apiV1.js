const express = require('express');

const {
  privateNoStore,
  respondIfPublishingGate,
  respondOperationUnavailable,
  sendPublishingMaintenance
} = require('../middleware/responsePolicy');
const { buildCapabilities } = require('../utils/apiCapabilities');
const {
  isApiKeyCredentialChangedError,
  legacyCredentialIdentity,
  parseApiKeyScopes
} = require('../utils/apiKeyIdentity');
const {
  formatContentEtag,
  isSnapshotPurged,
  toContentRevisionString
} = require('../utils/contentRevision');
const {
  computeRequestHmac,
  isIdempotencyConflictError,
  legacyKeyNamespace,
  managedKeyNamespace,
  parseIdempotencyKey
} = require('../utils/idempotency');
const { getMarkdownThemeOptions } = require('../utils/markdownThemeCatalog');
const { formatAccessEtag } = require('../utils/shareAccess');
const {
  encodeShareListCursor,
  hasAnyGrantPermission,
  parseShareListCursor
} = require('../utils/shareGrants');

function createApiV1Router({ config, pageRepository, auth, publicUrls, shareOps, parsers }) {
  const router = express.Router();
  const {
    requireApiKey,
    requireApiScope,
    requireApiScopesAll
  } = auth;
  const {
    ifNoneMatchMatches,
    instanceOrigin,
    isCreateValidationError,
    executeIdempotentCreate,
    createOutcomePayload,
    operationReceipt,
    accessPreconditionState,
    contentPreconditionState,
    createPageFromInput,
    apiRevisionMetaJson
  } = shareOps;
  const {
    parseShareJson,
    parseSmallJsonBody
  } = parsers;

  // Connection identity (T05): who this credential is, verified at request
  // start. Returns the instance origin, the credential kind and — for managed
  // Keys — the logical Key ID, name and current credential version. Never
  // returns any secret or hash. This is a read: it stays available while
  // publishing writes are paused for maintenance.
  router.get('/api/v1/me', privateNoStore, requireApiKey, (req, res) => {
    const credential = req.apiCredential || legacyCredentialIdentity();

    return res.json({
      success: true,
      origin: instanceOrigin(req),
      credential: {
        type: credential.type,
        keyId: credential.keyId,
        name: credential.name,
        credentialVersion: credential.credentialVersion,
        // The credential's OWN scopes (T12): a managed Key reports the
        // list stored on its row — create-only until the owner assigns
        // more in the admin — and the legacy Key reports create-only.
        scopes: [...parseApiKeyScopes(credential.scopes)]
      }
    });
  });

  // Connection capabilities (T05): the API surface this instance and
  // credential actually support, serialized from the single definition in
  // utils/apiCapabilities.js that the routes themselves enforce. Contains no
  // secret material and no per-resource data. Also a read: available during
  // write maintenance, so an agent can still check its connection.
  router.get('/api/v1/capabilities', privateNoStore, requireApiKey, (req, res) => {
    const credential = req.apiCredential || legacyCredentialIdentity();

    return res.json({
      success: true,
      origin: instanceOrigin(req),
      capabilities: buildCapabilities({
        credentialType: credential.type,
        scopes: credential.scopes
      })
    });
  });

  // Operation confirmation (T08): after a create response is lost, the
  // caller confirms the outcome by its request identifier. The lookup is
  // scoped to the caller's own credential namespace — a legacy Key can
  // confirm its own creates, and this confirmation belongs to the create
  // capability rather than granting any Share management. Only status and
  // resource/version identifiers are returned: never a password, title,
  // description or body, and never under a share-access authorization.
  // This is a read: it stays available while writes are paused.
  router.get('/api/v1/operations/:requestId', privateNoStore, requireApiKey, async (req, res) => {
    const parsed = parseIdempotencyKey(req.params.requestId);

    if (!parsed.provided || !parsed.valid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request id',
        code: 'invalid_request_id',
        retryable: false
      });
    }

    try {
      const credential = req.apiCredential || legacyCredentialIdentity();
      const namespace = credential.type === 'managed'
        ? managedKeyNamespace(credential.keyId)
        : legacyKeyNamespace(config.shareApiKey);
      const record = await pageRepository.getOperation(namespace, parsed.value);

      if (!record) {
        return res.status(404).json({
          success: false,
          error: 'Operation not found',
          code: 'operation_not_found',
          requestId: parsed.value,
          retryable: false
        });
      }

      return res.json({
        success: true,
        requestId: record.requestId,
        action: record.action,
        status: record.resultState,
        shareId: record.resultShareId,
        contentRevision: record.resultRevision,
        accessRevision: record.resultAccessRevision,
        createdAt: record.createdAt
      });
    } catch (error) {
      console.error('Operation lookup failed:', error);
      return res.status(500).json({ success: false, error: '服务器错误' });
    }
  });

  // Granted-Share list (T12, issue #36): the Shares THIS credential holds
  // a grant on — never the instance's Shares in general — in the stable
  // (createdAt, id) cursor order. Listing is a read-family operation: the
  // credential needs at least one management scope (read/update/publish)
  // to list at all, and each entry is additionally filtered to the
  // permissions the conjunction of scope and grant actually yields, so a
  // grant whose scope the Key no longer holds does not surface. Entries
  // without effective read carry neutralized title/description (parent
  // spec #24 §7); no entry ever carries password material, the grant
  // table itself, or the Favorite flag. Reads stay available during
  // write maintenance.
  router.get('/api/v1/shares', privateNoStore, requireApiKey, requireApiScope('share:read', 'share:update', 'share:publish'), async (req, res) => {
    const credential = req.apiCredential || legacyCredentialIdentity();

    let limit = 20;

    if (req.query.limit !== undefined) {
      const parsedLimit = Number(req.query.limit);

      if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
        return res.status(400).json({
          success: false,
          error: 'Invalid limit',
          code: 'invalid_limit',
          retryable: false
        });
      }

      limit = Math.min(parsedLimit, 100);
    }

    let cursor = null;

    if (req.query.cursor !== undefined && req.query.cursor !== '') {
      cursor = parseShareListCursor(req.query.cursor);

      if (!cursor) {
        return res.status(400).json({
          success: false,
          error: 'Invalid cursor',
          code: 'invalid_cursor',
          retryable: false
        });
      }
    }

    try {
      const { shares, nextPosition } = await pageRepository.listGrantedShares({
        keyId: credential.keyId,
        limit,
        cursor
      });
      const held = credential.scopes || [];
      const visible = [];

      for (const share of shares) {
        const permissions = {
          read: share.permissions.read && held.includes('share:read'),
          update: share.permissions.update && held.includes('share:update'),
          publish: share.permissions.publish && held.includes('share:publish')
        };

        if (!hasAnyGrantPermission(permissions)) {
          continue;
        }

        visible.push({
          id: share.id,
          codeType: share.codeType,
          title: permissions.read ? share.title : null,
          description: permissions.read ? share.description : null,
          markdownTheme: permissions.read ? share.markdownTheme : null,
          createdAt: share.createdAt,
          expiresAt: share.expiresAt,
          isProtected: share.isProtected,
          published: share.published,
          contentRevision: share.contentRevision,
          accessRevision: share.accessRevision,
          permissions
        });
      }

      return res.json({
        success: true,
        shares: visible,
        nextCursor: nextPosition ? encodeShareListCursor(nextPosition) : null
      });
    } catch (error) {
      console.error('Granted share list failed:', error);
      return res.status(500).json({ success: false, error: '服务器错误' });
    }
  });

  // Granted-Share content read (T12): the current Revision snapshot of a
  // Share the credential is granted to read. Requires the read scope
  // (403 without it) AND a read grant on this Share (404 without one —
  // the same 404 as a nonexistent Share). Management authorization is
  // judged independently of public visibility: an unpublished or expired
  // Share reads exactly like a live one here, and neither the share
  // access cookie nor public view rights authorize this surface. The
  // response body is exactly the content representation the strong
  // content ETag covers — no timestamps, view counts or request data —
  // and a purged current snapshot stays unavailable (410), as everywhere.
  router.get('/api/v1/shares/:id/content', privateNoStore, requireApiKey, requireApiScope('share:read'), async (req, res) => {
    const credential = req.apiCredential || legacyCredentialIdentity();

    try {
      const result = await pageRepository.getGrantedShareContent({
        keyId: credential.keyId,
        shareId: req.params.id
      });

      if (!result || !result.permissions.read) {
        return res.status(404).json({
          success: false,
          error: 'Share not found',
          code: 'share_not_found',
          retryable: false
        });
      }

      if (result.snapshot && result.snapshot.purgedAt !== null && result.snapshot.purgedAt !== undefined) {
        return res.status(410).json({
          success: false,
          error: 'Revision content has been purged',
          code: 'revision_unavailable',
          retryable: false
        });
      }

      const fields = result.snapshot || result.live;
      const contentRevision = result.currentRevision;
      const etag = contentRevision ? formatContentEtag(result.shareId, contentRevision) : null;

      if (etag) {
        res.set('ETag', etag);
      }

      if (etag && ifNoneMatchMatches(req.get('if-none-match'), etag)) {
        return res.status(304).end();
      }

      return res.json({
        success: true,
        share: {
          id: result.shareId,
          contentRevision,
          htmlContent: fields.htmlContent,
          codeType: fields.codeType,
          title: fields.title,
          description: fields.description,
          markdownTheme: fields.markdownTheme
        }
      });
    } catch (error) {
      console.error('Granted share content read failed:', error);
      return res.status(500).json({ success: false, error: '服务器错误' });
    }
  });

  // Granted-Share state read (T12): the restricted state model — ID,
  // published, isProtected, expiresAt, accessRevision, and nothing else.
  // The repository query never selects title, description or body, so
  // this surface cannot leak them; the response is identical for every
  // authorized caller, whether they matched through the read or the
  // publish permission (parent spec #24 §6). The state ETag is the access
  // tag family, distinct from the content ETag, and it moves whenever an
  // access-policy change advances access_revision.
  router.get('/api/v1/shares/:id/state', privateNoStore, requireApiKey, requireApiScope('share:read', 'share:publish'), async (req, res) => {
    const credential = req.apiCredential || legacyCredentialIdentity();
    const held = credential.scopes || [];

    try {
      const result = await pageRepository.getGrantedShareState({
        keyId: credential.keyId,
        shareId: req.params.id
      });

      const matched = Boolean(result) && (
        (result.permissions.read && held.includes('share:read'))
        || (result.permissions.publish && held.includes('share:publish'))
      );

      if (!matched) {
        return res.status(404).json({
          success: false,
          error: 'Share not found',
          code: 'share_not_found',
          retryable: false
        });
      }

      const etag = formatAccessEtag(result.share.id, result.share.accessRevision);
      res.set('ETag', etag);

      if (ifNoneMatchMatches(req.get('if-none-match'), etag)) {
        return res.status(304).end();
      }

      return res.json({
        success: true,
        share: { ...result.share }
      });
    } catch (error) {
      console.error('Granted share state read failed:', error);
      return res.status(500).json({ success: false, error: '服务器错误' });
    }
  });

  // Granted-Share content update (T13, issue #37): a managed Key with
  // the read AND update scopes and an update grant on this Share
  // replaces its content with a complete snapshot. The write reuses the
  // dashboard's content transaction wholesale — the same repository
  // operation protocol, compare-and-swap, no-op rule and audit — in the
  // Key's own operation namespace; it is not a second editing rule set.
  // The full snapshot is strict (parent spec #24 §7): htmlContent,
  // title, description and markdownTheme are all required, codeType may
  // be sent but must equal the Share's fixed type, an unknown Markdown
  // Preset is a 400 rather than a silent substitution, and any field
  // outside the snapshot — access policy, favorite, counters, publish
  // state — is refused instead of being silently ignored. Both the
  // concrete content If-Match and an Idempotency-Key are required.
  // Management authorization is judged independently of public
  // visibility: an unpublished or expired Share updates exactly like a
  // live one here.
  router.put('/api/v1/shares/:id/content', privateNoStore, requireApiKey, requireApiScopesAll('share:read', 'share:update'), parseShareJson, async (req, res) => {
    const credential = req.apiCredential || legacyCredentialIdentity();
    const shareId = req.params.id;

    // The request identifier is mandatory on this surface (parent spec
    // #24 §8): absent or malformed is a client error, never a silent
    // downgrade to a non-idempotent write.
    const idem = parseIdempotencyKey(req.get('idempotency-key'));

    if (!idem.valid) {
      return res.status(400).json({
        success: false,
        error: 'A valid Idempotency-Key header is required',
        code: 'invalid_idempotency_key',
        retryable: false
      });
    }

    const requestId = idem.value;

    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : null;

      if (!body) {
        return res.status(400).json({
          success: false,
          error: 'Request body must be a JSON object',
          code: 'invalid_body',
          retryable: false
        });
      }

      const allowedFields = ['htmlContent', 'title', 'description', 'markdownTheme', 'codeType'];

      for (const field of Object.keys(body)) {
        if (!allowedFields.includes(field)) {
          return res.status(400).json({
            success: false,
            error: `Field cannot be set through the content update: ${field}`,
            code: 'invalid_field',
            field,
            retryable: false
          });
        }
      }

      for (const field of ['htmlContent', 'title', 'description', 'markdownTheme']) {
        if (!Object.prototype.hasOwnProperty.call(body, field)) {
          return res.status(400).json({
            success: false,
            error: `Missing required field: ${field}`,
            code: 'missing_field',
            field,
            retryable: false
          });
        }
      }

      if (typeof body.htmlContent !== 'string' || body.htmlContent.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'htmlContent must be a non-empty string',
          code: 'invalid_content',
          retryable: false
        });
      }

      if ((body.title !== null && typeof body.title !== 'string')
        || (body.description !== null && typeof body.description !== 'string')
        || (body.markdownTheme !== null && typeof body.markdownTheme !== 'string')
        || (body.codeType !== undefined && typeof body.codeType !== 'string')) {
        return res.status(400).json({
          success: false,
          error: 'title, description, markdownTheme and codeType must be strings or null',
          code: 'invalid_field',
          retryable: false
        });
      }

      // The grant half of the authorization conjunction, judged before
      // any state is read for validation: no update grant — or no such
      // Share — is the same 404, so this surface cannot probe which
      // Shares exist. The repository re-verifies the grant inside the
      // write transaction; this check only fails fast.
      const grant = await pageRepository.getShareGrant(credential.keyId, shareId);

      if (!grant || !grant.permissions.update) {
        return res.status(404).json({
          success: false,
          error: 'Share not found',
          code: 'share_not_found',
          retryable: false
        });
      }

      const page = await pageRepository.getById(shareId);

      if (!page) {
        return res.status(404).json({
          success: false,
          error: 'Share not found',
          code: 'share_not_found',
          retryable: false
        });
      }

      // codeType is fixed at creation in this milestone (parent spec
      // #24 §3): it may be repeated in the snapshot, never changed.
      if (body.codeType !== undefined && body.codeType !== page.code_type) {
        return res.status(400).json({
          success: false,
          error: 'codeType cannot change after creation',
          code: 'code_type_mismatch',
          retryable: false
        });
      }

      // Strict Preset validation: for a Markdown Share the theme must
      // name a real Preset — an unknown one is a 400, never the silent
      // default substitution the create/dashboard paths apply — and for
      // every other type the snapshot's theme is null (parent spec #24
      // §7).
      const isMarkdown = page.code_type === 'markdown';
      let markdownTheme = null;

      if (isMarkdown) {
        const knownPreset = typeof body.markdownTheme === 'string'
          && getMarkdownThemeOptions().some(option => option.id === body.markdownTheme);

        if (!knownPreset) {
          return res.status(400).json({
            success: false,
            error: 'Unknown Markdown theme preset',
            code: 'invalid_markdown_theme',
            retryable: false
          });
        }

        markdownTheme = body.markdownTheme;
      } else if (body.markdownTheme !== null) {
        return res.status(400).json({
          success: false,
          error: 'markdownTheme must be null for a non-Markdown Share',
          code: 'invalid_markdown_theme',
          retryable: false
        });
      }

      // Write maintenance outranks precondition validation (T04): while
      // paused, even a replay of this update is refused at the gate, and
      // the operation stays confirmable through the operations query.
      if (typeof pageRepository.getPublishingWritesPaused === 'function'
        && await pageRepository.getPublishingWritesPaused()) {
        return sendPublishingMaintenance(res);
      }

      const contentState = contentPreconditionState(req, shareId);
      const normalizedTitle = body.title ? body.title.trim() || null : null;
      const normalizedDescription = body.description ? body.description.trim() || null : null;

      const updateOptions = {
        htmlContent: body.htmlContent,
        title: normalizedTitle,
        description: normalizedDescription,
        markdownTheme
      };

      // The digest binds the identifier to this exact request (parent
      // spec §8), computed from the request alone — before any derived
      // value exists — so a byte-identical retry digests identically in
      // any state, while any other payload or expectation under the
      // same identifier is a conflict.
      const present = (value) => value !== undefined && value !== null;
      const requestHmac = computeRequestHmac({
        action: 'share.content.update',
        targetId: shareId,
        presence: {
          htmlContent: 1,
          title: present(body.title) ? 1 : 0,
          description: present(body.description) ? 1 : 0,
          markdownTheme: present(body.markdownTheme) ? 1 : 0,
          codeType: present(body.codeType) ? 1 : 0,
          expectedContentRevision: contentState.digestValue !== null ? 1 : 0
        },
        values: {
          htmlContent: body.htmlContent,
          title: normalizedTitle,
          description: normalizedDescription,
          markdownTheme,
          codeType: present(body.codeType) ? body.codeType : null,
          expectedContentRevision: contentState.digestValue
        }
      });

      const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
      const outcome = await pageRepository.saveContentIdempotent({
        id: shareId,
        options: updateOptions,
        precondition: {
          expectedAccessRevision: null,
          accessPreconditionMissing: false,
          advanceAccessRevision: false,
          expectedContentRevision: contentState.expectedContentRevision,
          contentPreconditionMissing: contentState.contentPreconditionMissing,
          contentPreconditionInvalid: contentState.contentPreconditionInvalid,
          contentMeta: { source: 'api-update', actorType: 'api_key', actorId: credential.keyId },
          ip
        },
        operation: {
          actorNamespace: managedKeyNamespace(credential.keyId),
          requestId,
          action: 'share.content.update',
          targetId: shareId,
          requestHmac
        },
        apiCredential: credential,
        grantCheck: { keyId: credential.keyId, permission: 'update' }
      });

      const base = config.shareBaseUrl || `${req.protocol}://${req.get('host')}`;
      const url = `${base.replace(/\/+$/, '')}/view/${shareId}`;

      if (outcome.outcome === 'unavailable') {
        return respondOperationUnavailable(res, requestId);
      }

      if (outcome.outcome === 'replayed') {
        const receipt = operationReceipt(outcome.operation);

        if (!receipt || receipt.kind !== 'share.content.update' || receipt.shareId !== shareId) {
          return respondOperationUnavailable(res, requestId);
        }

        return res.json({
          success: true,
          replayed: true,
          requestId,
          action: 'share.content.update',
          shareId,
          url,
          contentChanged: receipt.contentChanged === true,
          contentRevision: receipt.contentRevision,
          contentEtag: formatContentEtag(shareId, receipt.contentRevision),
          accessRevision: receipt.accessRevision
        });
      }

      const result = outcome.result;

      if (result.status === 'grant_not_found' || result.status === 'not_found') {
        return res.status(404).json({
          success: false,
          error: 'Share not found',
          code: 'share_not_found',
          retryable: false
        });
      }

      if (result.status === 'precondition_required') {
        return res.status(428).json({
          success: false,
          error: '缺少内容版本前置条件 If-Match，请刷新后重试',
          code: 'content_precondition_required',
          requestId,
          contentRevision: result.contentRevision,
          contentEtag: formatContentEtag(shareId, result.contentRevision),
          retryable: false
        });
      }

      if (result.status === 'content_conflict') {
        // The candidate was NOT applied and the caller's draft is
        // preserved; the response carries the current remote snapshot so
        // the caller can show the difference and decide — the latest
        // revision is never filled in silently (parent spec #24 §7,
        // user story 36).
        return res.status(412).json({
          success: false,
          error: '内容已被更新，你的稿件未被覆盖，请查看差异后决定如何处理',
          code: 'content_conflict',
          requestId,
          contentRevision: result.contentRevision,
          contentEtag: formatContentEtag(shareId, result.contentRevision),
          current: result.current,
          retryable: false
        });
      }

      return res.json({
        success: true,
        requestId,
        action: 'share.content.update',
        shareId,
        url,
        contentChanged: result.contentChanged === true,
        contentRevision: result.contentRevision,
        contentEtag: formatContentEtag(shareId, result.contentRevision),
        accessRevision: result.accessRevision,
        share: {
          id: shareId,
          contentRevision: result.contentRevision,
          htmlContent: updateOptions.htmlContent,
          codeType: page.code_type,
          title: updateOptions.title,
          description: updateOptions.description,
          markdownTheme: updateOptions.markdownTheme
        }
      });
    } catch (error) {
      console.error('Granted share content update failed:', error);
      // The credential was rotated or deleted after this request
      // verified it: the write was refused inside its transaction
      // (T05/T13). From the client's side the presented credential is
      // simply no longer valid.
      if (isApiKeyCredentialChangedError(error)) {
        return res.status(401).json({
          success: false,
          error: 'Invalid API key',
          code: 'api_key_credential_changed',
          retryable: false
        });
      }
      if (isIdempotencyConflictError(error)) {
        return res.status(409).json({
          success: false,
          error: 'Idempotency-Key was already used with a different request',
          code: 'idempotency_conflict',
          requestId,
          retryable: false
        });
      }
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({ success: false, error: '服务器错误' });
    }
  });

  // Granted-Share history list (T14, issue #38): the Revision metadata
  // of a Share the credential is granted to READ — version, capture
  // time, source, restore provenance, purge state — newest first,
  // paginated like the dashboard history browser (default 20, max 100).
  // Metadata only: this surface never aggregates snapshot bodies.
  // Authorization is the T12 conjunction: read scope (403 without it)
  // AND a read grant on this Share (404 without one — the same 404 as a
  // nonexistent Share, and a publish-only grant does not imply read).
  // Management authorization is judged independently of public
  // visibility, and neither the share access cookie nor public view
  // rights authorize this surface. The dashboard history stays
  // owner-only (T07); this is a separate, grant-scoped API surface.
  // Reads stay available during write maintenance.
  router.get('/api/v1/shares/:id/revisions', privateNoStore, requireApiKey, requireApiScope('share:read'), async (req, res) => {
    const credential = req.apiCredential || legacyCredentialIdentity();

    let limit = 20;

    if (req.query.limit !== undefined) {
      const parsedLimit = Number(req.query.limit);

      if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
        return res.status(400).json({
          success: false,
          error: 'Invalid limit',
          code: 'invalid_limit',
          retryable: false
        });
      }

      limit = Math.min(parsedLimit, 100);
    }

    let offset = 0;

    if (req.query.offset !== undefined) {
      const parsedOffset = Number(req.query.offset);

      if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid offset',
          code: 'invalid_offset',
          retryable: false
        });
      }

      offset = parsedOffset;
    }

    try {
      const result = await pageRepository.getGrantedShareRevisions({
        keyId: credential.keyId,
        shareId: req.params.id,
        limit,
        offset
      });

      if (!result || !result.permissions.read) {
        return res.status(404).json({
          success: false,
          error: 'Share not found',
          code: 'share_not_found',
          retryable: false
        });
      }

      return res.json({
        success: true,
        shareId: result.shareId,
        currentRevision: result.currentRevision,
        total: result.total,
        limit,
        offset,
        revisions: result.revisions.map(record => apiRevisionMetaJson(record, result.currentRevision))
      });
    } catch (error) {
      console.error('Granted share history list failed:', error);
      return res.status(500).json({ success: false, error: '服务器错误' });
    }
  });

  // Granted-Share single-Revision read (T14): the complete snapshot of
  // one Revision of a granted Share — the canonical snapshot GET of the
  // parent spec's API contract. A purged Revision is a tombstone: its
  // metadata stays visible in the history list, but its payload answers
  // 410 here, exactly as in the dashboard. The response carries the
  // snapshot's own strong content ETag (the content family names the
  // Revision it covers, current or not) and honors If-None-Match with
  // the same weak comparison as the current-content read.
  router.get('/api/v1/shares/:id/revisions/:revision', privateNoStore, requireApiKey, requireApiScope('share:read'), async (req, res) => {
    const credential = req.apiCredential || legacyCredentialIdentity();
    const revision = toContentRevisionString(req.params.revision);

    if (revision === null) {
      return res.status(404).json({
        success: false,
        error: 'Revision not found',
        code: 'revision_not_found',
        retryable: false
      });
    }

    try {
      const result = await pageRepository.getGrantedShareRevision({
        keyId: credential.keyId,
        shareId: req.params.id,
        revision
      });

      if (!result || !result.permissions.read) {
        return res.status(404).json({
          success: false,
          error: 'Share not found',
          code: 'share_not_found',
          retryable: false
        });
      }

      if (!result.snapshot) {
        return res.status(404).json({
          success: false,
          error: 'Revision not found',
          code: 'revision_not_found',
          retryable: false
        });
      }

      const snapshot = result.snapshot;

      if (isSnapshotPurged(snapshot)) {
        return res.status(410).json({
          success: false,
          error: 'Revision content has been purged',
          code: 'revision_unavailable',
          retryable: false,
          revision: apiRevisionMetaJson(snapshot, result.currentRevision)
        });
      }

      const etag = formatContentEtag(req.params.id, snapshot.revision);
      res.set('ETag', etag);

      if (ifNoneMatchMatches(req.get('if-none-match'), etag)) {
        return res.status(304).end();
      }

      return res.json({
        success: true,
        revision: {
          ...apiRevisionMetaJson(snapshot, result.currentRevision),
          codeType: snapshot.code_type,
          title: snapshot.title,
          description: snapshot.description,
          markdownTheme: snapshot.markdown_theme,
          htmlContent: snapshot.html_content,
          contentEtag: etag
        }
      });
    } catch (error) {
      console.error('Granted share revision read failed:', error);
      return res.status(500).json({ success: false, error: '服务器错误' });
    }
  });

  // Granted-Share history restore (T14, issue #38): a managed Key with
  // the read AND update scopes and an update grant on this Share makes
  // one of its Revisions current again. The restore reuses the
  // dashboard's restore transaction wholesale — the same repository
  // operation, replay-before-precondition resolution, restored-from
  // provenance, identical-content no-op and audit — in the Key's own
  // operation namespace; it is not a second restore rule set. The body
  // (the small-request parser: a restore names a version, it does not
  // carry content) holds exactly one field, `revision`; the concrete
  // content If-Match of the CURRENT Revision and an Idempotency-Key are
  // both mandatory (parent spec #24 §7/§8). Only content fields move:
  // the restore never touches the URL, password, expiry,
  // access_revision, Key authorization, publish state, favorite or view
  // count. There is deliberately NO Key-facing purge endpoint — history
  // purge stays an owner dashboard action (T10).
  router.post('/api/v1/shares/:id/restore', privateNoStore, requireApiKey, requireApiScopesAll('share:read', 'share:update'), parseSmallJsonBody, async (req, res) => {
    const credential = req.apiCredential || legacyCredentialIdentity();
    const shareId = req.params.id;

    // The request identifier is mandatory on this surface (parent spec
    // #24 §8): absent or malformed is a client error, never a silent
    // downgrade to a non-idempotent write.
    const idem = parseIdempotencyKey(req.get('idempotency-key'));

    if (!idem.valid) {
      return res.status(400).json({
        success: false,
        error: 'A valid Idempotency-Key header is required',
        code: 'invalid_idempotency_key',
        retryable: false
      });
    }

    const requestId = idem.value;

    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : null;

      if (!body) {
        return res.status(400).json({
          success: false,
          error: 'Request body must be a JSON object',
          code: 'invalid_body',
          retryable: false
        });
      }

      for (const field of Object.keys(body)) {
        if (field !== 'revision') {
          return res.status(400).json({
            success: false,
            error: `Field cannot be set through the restore: ${field}`,
            code: 'invalid_field',
            field,
            retryable: false
          });
        }
      }

      if (!Object.prototype.hasOwnProperty.call(body, 'revision')) {
        return res.status(400).json({
          success: false,
          error: 'Missing required field: revision',
          code: 'missing_field',
          field: 'revision',
          retryable: false
        });
      }

      const sourceRevision = toContentRevisionString(body.revision);

      if (sourceRevision === null) {
        return res.status(400).json({
          success: false,
          error: 'revision must be a positive decimal version string',
          code: 'invalid_field',
          field: 'revision',
          retryable: false
        });
      }

      // The grant half of the authorization conjunction, judged before
      // any state is read for validation: no update grant — or no such
      // Share — is the same 404, so this surface cannot probe which
      // Shares exist. The repository re-verifies the grant inside the
      // restore transaction; this check only fails fast.
      const grant = await pageRepository.getShareGrant(credential.keyId, shareId);

      if (!grant || !grant.permissions.update) {
        return res.status(404).json({
          success: false,
          error: 'Share not found',
          code: 'share_not_found',
          retryable: false
        });
      }

      const page = await pageRepository.getById(shareId);

      if (!page) {
        return res.status(404).json({
          success: false,
          error: 'Share not found',
          code: 'share_not_found',
          retryable: false
        });
      }

      // Write maintenance outranks precondition validation (T04): while
      // paused, even a replay of this restore is refused at the gate,
      // and the operation stays confirmable through the operations
      // query.
      if (typeof pageRepository.getPublishingWritesPaused === 'function'
        && await pageRepository.getPublishingWritesPaused()) {
        return sendPublishingMaintenance(res);
      }

      const contentState = contentPreconditionState(req, shareId);
      const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;

      const outcome = await pageRepository.restoreRevision({
        id: shareId,
        sourceRevision,
        precondition: {
          expectedContentRevision: contentState.expectedContentRevision,
          contentPreconditionMissing: contentState.contentPreconditionMissing,
          contentPreconditionInvalid: contentState.contentPreconditionInvalid,
          ip
        },
        operation: {
          actorNamespace: managedKeyNamespace(credential.keyId),
          requestId,
          action: 'share.restore',
          targetId: shareId,
          // The digest binds the identifier to this exact request
          // (parent spec §8), computed from the request alone — the
          // source version and the caller's expected current version —
          // so a byte-identical retry digests identically in any state,
          // while any other source or baseline under the same
          // identifier is a conflict. It matches the dashboard
          // restore's digest for the same inputs; the namespaces keep
          // the two actors' records apart.
          requestHmac: computeRequestHmac({
            action: 'share.restore',
            targetId: shareId,
            presence: {
              sourceRevision: 1,
              expectedContentRevision: contentState.digestValue !== null ? 1 : 0
            },
            values: {
              sourceRevision,
              expectedContentRevision: contentState.digestValue
            }
          })
        },
        apiCredential: credential,
        grantCheck: { keyId: credential.keyId, permission: 'update' },
        restoreMeta: { source: 'api-restore', actorType: 'api_key', actorId: credential.keyId }
      });

      if (outcome.outcome === 'unavailable') {
        return respondOperationUnavailable(res, requestId);
      }

      if (outcome.outcome === 'replayed') {
        const receipt = operationReceipt(outcome.operation);

        if (!outcome.shareState || !receipt || receipt.kind !== 'share.restore' || receipt.shareId !== shareId) {
          return respondOperationUnavailable(res, requestId);
        }

        return res.json({
          success: true,
          replayed: true,
          requestId,
          action: 'share.restore',
          shareId,
          sourceRevision: receipt.sourceRevision,
          previousRevision: receipt.previousRevision,
          contentRevision: receipt.contentRevision,
          contentEtag: formatContentEtag(shareId, receipt.contentRevision),
          contentChanged: receipt.contentChanged === true,
          unchanged: receipt.contentChanged !== true
        });
      }

      const result = outcome.result;

      if (result.status === 'grant_not_found' || result.status === 'not_found') {
        return res.status(404).json({
          success: false,
          error: 'Share not found',
          code: 'share_not_found',
          retryable: false
        });
      }

      if (result.status === 'source_not_found') {
        return res.status(404).json({
          success: false,
          error: 'Revision not found',
          code: 'revision_not_found',
          retryable: false
        });
      }

      if (result.status === 'source_unavailable') {
        return res.status(410).json({
          success: false,
          error: '该版本内容已被清除，无法恢复',
          code: 'revision_unavailable',
          retryable: false
        });
      }

      if (result.status === 'precondition_required') {
        return res.status(428).json({
          success: false,
          error: '缺少内容版本前置条件 If-Match，请刷新后重试',
          code: 'content_precondition_required',
          requestId,
          contentRevision: result.contentRevision,
          contentEtag: formatContentEtag(shareId, result.contentRevision),
          retryable: false
        });
      }

      if (result.status === 'content_conflict') {
        return res.status(412).json({
          success: false,
          error: '内容已被更新，恢复未执行，请确认最新版本后重试',
          code: 'content_conflict',
          requestId,
          contentRevision: result.contentRevision,
          contentEtag: formatContentEtag(shareId, result.contentRevision),
          current: result.current,
          retryable: false
        });
      }

      return res.json({
        success: true,
        requestId,
        action: 'share.restore',
        shareId,
        sourceRevision: result.sourceRevision,
        previousRevision: result.previousRevision,
        contentRevision: result.contentRevision,
        contentEtag: formatContentEtag(shareId, result.contentRevision),
        contentChanged: result.contentChanged === true,
        unchanged: result.contentChanged !== true
      });
    } catch (error) {
      console.error('Granted share restore failed:', error);
      // The credential was rotated or deleted after this request
      // verified it: the write was refused inside its transaction
      // (T05/T14). From the client's side the presented credential is
      // simply no longer valid.
      if (isApiKeyCredentialChangedError(error)) {
        return res.status(401).json({
          success: false,
          error: 'Invalid API key',
          code: 'api_key_credential_changed',
          retryable: false
        });
      }
      if (isIdempotencyConflictError(error)) {
        return res.status(409).json({
          success: false,
          error: 'Idempotency-Key was already used with a different request',
          code: 'idempotency_conflict',
          requestId,
          retryable: false
        });
      }
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({ success: false, error: '服务器错误' });
    }
  });

  // Granted publish-state transitions (T15, issue #39): a managed Key
  // with the publish scope and a publish grant on this Share unpublishes
  // or republishes it. Edit rights never imply this operation — an
  // editor without a separate publish grant is refused exactly like any
  // other unauthorized caller — and a publish grant never implies read:
  // this surface returns only the restricted state fields the state
  // representation carries. The transition reuses the dashboard's
  // publish-state transaction wholesale (T11) — the same repository
  // operation protocol, access-version compare-and-swap, no-op rule and
  // audit — in the Key's own operation namespace; it is not a second
  // state machine. The precondition is the current STATE If-Match (the
  // access-family tag): a content tag can never stand in for it, and
  // neither can a weak tag, a wildcard or a list (parent spec #24 §4/§7).
  // Both the concrete state If-Match and an Idempotency-Key are
  // required. The write re-verifies, inside its transaction, both the
  // credential version and the caller's current publish grant before
  // any replay is honored, so a rotation or revocation that committed
  // first refuses the transition and a revoked Key cannot replay its
  // own earlier result (§8). Management authorization is judged
  // independently of public visibility: an expired Share transitions
  // exactly like a live one, and republishing never extends its expiry,
  // changes its password or touches its content or history.
  function grantedPublishStateHandler(targetPublished) {
    const action = targetPublished ? 'share.republish' : 'share.unpublish';

    return async (req, res) => {
      const credential = req.apiCredential || legacyCredentialIdentity();
      const shareId = req.params.id;

      // The request identifier is mandatory on this surface (parent
      // spec #24 §8): absent or malformed is a client error, never a
      // silent downgrade to a non-idempotent write.
      const idem = parseIdempotencyKey(req.get('idempotency-key'));

      if (!idem.valid) {
        return res.status(400).json({
          success: false,
          error: 'A valid Idempotency-Key header is required',
          code: 'invalid_idempotency_key',
          retryable: false
        });
      }

      const requestId = idem.value;

      try {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? req.body
          : null;

        if (!body) {
          return res.status(400).json({
            success: false,
            error: 'Request body must be a JSON object',
            code: 'invalid_body',
            retryable: false
          });
        }

        // The target state is named by the endpoint itself; the request
        // carries no fields at all. Anything named here would be a field
        // this operation does not accept — refused, never ignored, so a
        // caller cannot believe it set the password, the expiry or the
        // content through a publish-state call.
        for (const field of Object.keys(body)) {
          return res.status(400).json({
            success: false,
            error: `Field cannot be set through the ${action} operation: ${field}`,
            code: 'invalid_field',
            field,
            retryable: false
          });
        }

        // The grant half of the authorization conjunction, judged before
        // any state is read for validation: no publish grant — or no
        // such Share — is the same 404, so this surface cannot probe
        // which Shares exist. The repository re-verifies the grant
        // inside the transition transaction; this check only fails fast.
        const grant = await pageRepository.getShareGrant(credential.keyId, shareId);

        if (!grant || !grant.permissions.publish) {
          return res.status(404).json({
            success: false,
            error: 'Share not found',
            code: 'share_not_found',
            retryable: false
          });
        }

        const page = await pageRepository.getById(shareId);

        if (!page) {
          return res.status(404).json({
            success: false,
            error: 'Share not found',
            code: 'share_not_found',
            retryable: false
          });
        }

        // Write maintenance outranks precondition validation (T04):
        // while paused, even a replay of this transition is refused at
        // the gate, and the operation stays confirmable through the
        // operations query.
        if (typeof pageRepository.getPublishingWritesPaused === 'function'
          && await pageRepository.getPublishingWritesPaused()) {
          return sendPublishingMaintenance(res);
        }

        const accessState = accessPreconditionState(req, shareId);
        const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;

        const outcome = await pageRepository.setPublishedState({
          id: shareId,
          published: targetPublished,
          precondition: {
            expectedAccessRevision: accessState.expectedAccessRevision,
            accessPreconditionMissing: accessState.accessPreconditionMissing
          },
          operation: {
            actorNamespace: managedKeyNamespace(credential.keyId),
            requestId,
            action,
            targetId: shareId,
            // The digest binds the identifier to this exact request
            // (parent spec §8), computed from the request alone — the
            // action and the caller's expected access version — so a
            // byte-identical retry digests identically in any state,
            // while the opposite transition or any other baseline under
            // the same identifier is a conflict.
            requestHmac: computeRequestHmac({
              action,
              targetId: shareId,
              presence: {
                expectedAccessRevision: accessState.digestValue !== null ? 1 : 0
              },
              values: {
                expectedAccessRevision: accessState.digestValue
              }
            })
          },
          apiCredential: credential,
          grantCheck: { keyId: credential.keyId, permission: 'publish' },
          ip
        });

        if (outcome.outcome === 'unavailable') {
          return respondOperationUnavailable(res, requestId);
        }

        if (outcome.outcome === 'replayed') {
          const receipt = operationReceipt(outcome.operation);

          if (!outcome.shareState || !receipt || receipt.kind !== action || receipt.shareId !== shareId) {
            return respondOperationUnavailable(res, requestId);
          }

          return res.json({
            success: true,
            replayed: true,
            requestId,
            action,
            shareId,
            published: receipt.published === true,
            changed: receipt.changed === true,
            unchanged: receipt.changed !== true,
            accessRevision: receipt.accessRevision,
            accessEtag: formatAccessEtag(shareId, receipt.accessRevision)
          });
        }

        const result = outcome.result;

        if (result.status === 'grant_not_found' || result.status === 'not_found') {
          return res.status(404).json({
            success: false,
            error: 'Share not found',
            code: 'share_not_found',
            retryable: false
          });
        }

        if (result.status === 'access_precondition_required') {
          return res.status(428).json({
            success: false,
            error: '缺少状态版本前置条件 If-Match，请刷新后重试',
            code: 'access_precondition_required',
            requestId,
            accessRevision: result.accessRevision,
            accessEtag: formatAccessEtag(shareId, result.accessRevision),
            retryable: false
          });
        }

        if (result.status === 'conflict') {
          return res.status(412).json({
            success: false,
            error: '发布状态已被更新，请刷新后重试',
            code: 'access_conflict',
            requestId,
            accessRevision: result.accessRevision,
            accessEtag: formatAccessEtag(shareId, result.accessRevision),
            retryable: false
          });
        }

        return res.json({
          success: true,
          requestId,
          action,
          shareId,
          published: result.published === true,
          changed: result.changed === true,
          unchanged: result.changed !== true,
          accessRevision: result.accessRevision,
          accessEtag: formatAccessEtag(shareId, result.accessRevision)
        });
      } catch (error) {
        console.error('Granted share publish-state update failed:', error);
        // The credential was rotated or deleted after this request
        // verified it: the write was refused inside its transaction
        // (T05/T15). From the client's side the presented credential is
        // simply no longer valid.
        if (isApiKeyCredentialChangedError(error)) {
          return res.status(401).json({
            success: false,
            error: 'Invalid API key',
            code: 'api_key_credential_changed',
            retryable: false
          });
        }
        if (isIdempotencyConflictError(error)) {
          return res.status(409).json({
            success: false,
            error: 'Idempotency-Key was already used with a different request',
            code: 'idempotency_conflict',
            requestId,
            retryable: false
          });
        }
        if (respondIfPublishingGate(res, error)) {
          return;
        }
        return res.status(500).json({ success: false, error: '服务器错误' });
      }
    };
  }

  router.post('/api/v1/shares/:id/unpublish', privateNoStore, requireApiKey, requireApiScope('share:publish'), parseSmallJsonBody, grantedPublishStateHandler(false));
  router.post('/api/v1/shares/:id/republish', privateNoStore, requireApiKey, requireApiScope('share:publish'), parseSmallJsonBody, grantedPublishStateHandler(true));

  router.post('/api/v1/share', privateNoStore, requireApiKey, parseShareJson, async (req, res) => {

    // Idempotency-Key (T08): with the header, the create runs in the
    // caller's credential namespace — same key + same input replays the
    // original result, same key + different input is a 409. Without the
    // header the historical create runs unchanged (HTTP 200, same fields)
    // and is NOT idempotent.
    const idem = parseIdempotencyKey(req.get('idempotency-key'));

    if (idem.provided && !idem.valid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Idempotency-Key',
        code: 'invalid_idempotency_key',
        retryable: false
      });
    }

    try {
      if (idem.provided) {
        const credential = req.apiCredential || legacyCredentialIdentity();
        const namespace = credential.type === 'managed'
          ? managedKeyNamespace(credential.keyId)
          : legacyKeyNamespace(config.shareApiKey);
        const outcome = await executeIdempotentCreate(req, {
          namespace,
          requestId: idem.value,
          source: 'api',
          apiCredential: credential
        });
        const payload = createOutcomePayload(outcome);

        if (!payload) {
          return respondOperationUnavailable(res, idem.value);
        }

        const base = config.shareBaseUrl || `${req.protocol}://${req.get('host')}`;
        const url = `${base.replace(/\/+$/, '')}/view/${payload.shareId}`;

        return res.json({
          success: true,
          url,
          urlId: payload.shareId,
          password: payload.password,
          isProtected: payload.isProtected,
          codeType: payload.codeType,
          title: payload.title,
          description: payload.description,
          expiresAt: payload.expiresAt,
          markdownTheme: payload.markdownTheme,
          contentRevision: payload.contentRevision,
          contentEtag: payload.contentEtag,
          requestId: idem.value,
          ...(outcome.outcome === 'replayed' ? { replayed: true } : {})
        });
      }

      const result = await createPageFromInput(req.body, { apiCredential: req.apiCredential });

      if (result.error) {
        return res.status(400).json({ success: false, error: result.error });
      }

      const base = config.shareBaseUrl || `${req.protocol}://${req.get('host')}`;
      const url = `${base.replace(/\/+$/, '')}/view/${result.id}`;

      pageRepository.createAuditLog({
        action: 'page.create',
        pageId: result.id,
        details: JSON.stringify({ codeType: result.codeType, isProtected: result.isProtected, source: 'api' }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      }).catch((err) => { console.error('Audit log failed:', err); });

      return res.json({
        success: true,
        url,
        urlId: result.id,
        password: result.password,
        isProtected: result.isProtected,
        codeType: result.codeType,
        title: result.title,
        description: result.description,
        expiresAt: result.expiresAt,
        markdownTheme: result.markdownTheme,
        contentRevision: result.contentRevision,
        contentEtag: result.contentEtag
      });
    } catch (error) {
      console.error('Share API failed:', error);
      // The credential was rotated or deleted after this request verified
      // it: the write was refused inside its transaction (T05). From the
      // client's side the presented credential is simply no longer valid.
      if (isApiKeyCredentialChangedError(error)) {
        return res.status(401).json({
          success: false,
          error: 'Invalid API key',
          code: 'api_key_credential_changed',
          retryable: false
        });
      }
      if (isCreateValidationError(error)) {
        return res.status(400).json({ success: false, error: error.message });
      }
      if (isIdempotencyConflictError(error)) {
        return res.status(409).json({
          success: false,
          error: 'Idempotency-Key was already used with a different request',
          code: 'idempotency_conflict',
          requestId: idem.provided ? idem.value : null,
          retryable: false
        });
      }
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({ success: false, error: '服务器错误' });
    }
  });

  return router;
}

module.exports = {
  createApiV1Router
};
