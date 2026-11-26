const {
  formatContentEtag,
  parseContentIfMatch,
  toContentRevisionString
} = require('../utils/contentRevision');
const { computeRequestHmac } = require('../utils/idempotency');
const { resolveMarkdownThemeId } = require('../utils/markdownThemeCatalog');
const { derivePageTitle, normalizeTitle } = require('../utils/pageTitle');
const { normalizeCodeType } = require('../utils/sandboxDocument');
const {
  DEFAULT_PASSWORD_LENGTH,
  decryptSecret,
  encryptSecret,
  generateId,
  generateNumericPassword,
  hashSecret,
  parseCustomPassword
} = require('../utils/security');
const {
  accessRevisionMatches,
  parseAccessIfMatch,
  parseExpectedAccessRevision,
  toAccessRevisionString
} = require('../utils/shareAccess');

// --- Idempotent create pipeline (T08, issue #32) --------------------------
//
// A create is split into three deterministic stages:
//   1. prepareCreateInput — format validation and the normalized request
//      view (field presence + the exact values the create will store).
//      Nothing derived exists yet: no Share ID, no generated password,
//      no creation time. The request digest (parent spec §8) is computed
//      over exactly this view, so a retry produces the same digest.
//   2. deriveCreateValues — the only place derived values come into
//      existence (creation time, expiry validation against that time,
//      auto title, generated password + hashes). For an idempotent
//      create it runs inside the repository transaction, after the
//      operation lookup missed, so a replay never derives anything.
//   3. The repository commits Share + Revision 1 + create audit +
//      operation record atomically (or replays the committed record).
//
// The expiry FUTURE check deliberately lives in stage 2, not stage 1:
// the spec's fixed order is format → permission → lookup → timeliness,
// so an operation that committed while its expiry was still in the
// future stays confirmable after the expiry passes.

class CreateValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CreateValidationError';
  }
}

function createShareOperations({ config, pageRepository }) {
  // Shared expectedAccessRevision precondition handling for access-policy
  // writes (T01): a missing precondition is 428, a stale one is 412, and an
  // invalid format is 400. The latest revision is never filled in silently.
  function checkAccessPrecondition(req, res, page) {
    const expected = parseExpectedAccessRevision(req.body?.expectedAccessRevision);

    if (!expected.provided) {
      res.status(428).json({
        success: false,
        error: '缺少 expectedAccessRevision，请刷新后重试'
      });
      return null;
    }

    if (!expected.valid) {
      res.status(400).json({
        success: false,
        error: 'expectedAccessRevision 必须为十进制字符串'
      });
      return null;
    }

    if (!accessRevisionMatches(page.access_revision, expected.value)) {
      res.status(412).json({
        success: false,
        error: '访问策略已被更新，请刷新后重试',
        accessRevision: toAccessRevisionString(page.access_revision)
      });
      return null;
    }

    return expected.value;
  }

  // If-None-Match evaluation for the conditional resource reads (T12).
  // GET requests use the RFC 7232 WEAK comparison: a candidate matches
  // when it is `*`, or when its opaque tag — ignoring a `W/` prefix —
  // equals the current representation's strong tag. (Writes are the
  // opposite: If-Match stays strong-only, per parent spec #24 §4.)
  function ifNoneMatchMatches(header, currentEtag) {
    if (!currentEtag || typeof header !== 'string') {
      return false;
    }

    return header.split(',').some((candidate) => {
      const trimmed = candidate.trim();

      if (trimmed === '*') {
        return true;
      }

      const opaque = trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed;
      return opaque === currentEtag;
    });
  }

  // The instance's canonical origin for identity responses (T05): the
  // configured public base URL when one exists, otherwise the origin this
  // request actually arrived on.
  function instanceOrigin(req) {
    if (config.baseUrl) {
      return config.baseUrl.replace(/\/+$/, '');
    }

    return `${req.protocol}://${req.get('host')}`;
  }

  async function createPageWithRetry(data, { apiCredential, revisionMeta } = {}) {
    let lastError = null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = generateId();

      try {
        await pageRepository.create({
          ...data,
          id
        }, { apiCredential, revisionMeta });

        return id;
      } catch (error) {
        lastError = error;

        if (!String(error.message || '').includes('UNIQUE') &&
            !String(error.code || '').includes('23505')) {
          throw error;
        }
      }
    }

    throw lastError || new Error('Failed to create a unique page id');
  }

  function parseFutureExpiry(expiresAt, now) {
    if (expiresAt === undefined || expiresAt === null || expiresAt === '') {
      return { value: null, error: null };
    }

    const value = Number(expiresAt);

    if (!Number.isSafeInteger(value) || value <= now) {
      return { value: null, error: '到期时间必须晚于当前时间' };
    }

    return { value, error: null };
  }

  function isCreateValidationError(error) {
    return Boolean(error) && error.name === 'CreateValidationError';
  }

  function prepareCreateInput(input) {
    const {
      htmlContent,
      codeType,
      title,
      description,
      expiresAt,
      isProtected,
      password: requestedPassword,
      markdownTheme
    } = input || {};

    if (!htmlContent || typeof htmlContent !== 'string') {
      return { error: '请提供内容' };
    }

    const customPassword = parseCustomPassword(requestedPassword);

    if (customPassword.error) {
      return { error: customPassword.error };
    }

    // Expiry FORMAT only at this stage (a present value must be an
    // epoch-ms integer); whether it is still in the future is a stage-2
    // timeliness check.
    const expiryPresent = expiresAt !== undefined && expiresAt !== null && expiresAt !== '';
    let expiryValue = null;

    if (expiryPresent) {
      const parsed = Number(expiresAt);

      if (!Number.isSafeInteger(parsed)) {
        return { error: '到期时间必须晚于当前时间' };
      }

      expiryValue = parsed;
    }

    const present = (value) => value !== undefined && value !== null;
    const normalizedCodeType = normalizeCodeType(htmlContent, codeType);
    // The digest view mirrors exactly what the create stores: title in its
    // normalized form, description trimmed, code type and markdown theme
    // resolved. Presence is tracked separately from values so "field
    // absent" and "field present with an empty/neutral value" do not fold
    // into the same digest. A JSON null counts as absent for the optional
    // fields (create treats null and absent identically today).
    const presence = {
      codeType: present(codeType) ? 1 : 0,
      title: present(title) ? 1 : 0,
      description: present(description) ? 1 : 0,
      expiresAt: expiryPresent ? 1 : 0,
      isProtected: present(isProtected) ? 1 : 0,
      password: customPassword.provided ? 1 : 0,
      markdownTheme: present(markdownTheme) ? 1 : 0
    };
    const values = {
      htmlContent,
      codeType: normalizedCodeType,
      title: present(title) ? normalizeTitle(title) : null,
      description: present(description) ? String(description).trim() || null : null,
      expiresAt: expiryValue,
      isProtected: Boolean(isProtected),
      password: customPassword.provided ? customPassword.value : null,
      markdownTheme: normalizedCodeType === 'markdown'
        ? resolveMarkdownThemeId(markdownTheme)
        : null
    };

    return { error: null, presence, values, customPassword };
  }

  async function deriveCreateValues(prepared) {
    const { values } = prepared;
    const createdAt = Date.now();
    const expiry = parseFutureExpiry(values.expiresAt, createdAt);

    if (expiry.error) {
      throw new CreateValidationError(expiry.error);
    }

    const pageTitle = derivePageTitle(values.htmlContent, values.codeType, values.title, createdAt);
    const password = values.isProtected
      ? (prepared.customPassword.provided
        ? prepared.customPassword.value
        : generateNumericPassword(DEFAULT_PASSWORD_LENGTH))
      : null;
    const passwordHash = password ? await hashSecret(password) : null;
    const encryptedPassword = password ? encryptSecret(password) : null;

    return {
      pageData: {
        htmlContent: values.htmlContent,
        passwordHash,
        encryptedPassword,
        isProtected: Boolean(password),
        codeType: values.codeType,
        title: pageTitle,
        description: values.description,
        createdAt,
        expiresAt: expiry.value,
        markdownTheme: values.markdownTheme
      },
      password,
      pageTitle
    };
  }

  // The original-result receipt stored (encrypted) with the operation
  // record: exactly the fields the create response returns, never the
  // body. A replay serves these original values — not the Share's current
  // state — subject to the policy checks in replayedCreatePayload.
  function createResultReceipt(derived, id) {
    return {
      kind: 'share.create',
      shareId: id,
      password: derived.password,
      isProtected: derived.pageData.isProtected,
      codeType: derived.pageData.codeType,
      title: derived.pageTitle,
      description: derived.pageData.description,
      expiresAt: derived.pageData.expiresAt,
      markdownTheme: derived.pageData.markdownTheme,
      contentRevision: '1',
      contentEtag: formatContentEtag(id, '1')
    };
  }

  function createRevisionMeta(apiCredential) {
    // Every creation entry writes the Revision 1 baseline with the new
    // Share (T06); the snapshot provenance records which entry and actor
    // produced it.
    return apiCredential
      ? {
        source: 'api-create',
        actorType: 'api_key',
        actorId: apiCredential.keyId || null
      }
      : { source: 'web-create', actorType: 'owner', actorId: null };
  }

  // Runs an idempotent create through the repository. Returns the
  // repository outcome: { outcome: 'created', result } for a first
  // execution, { outcome: 'replayed' | 'unavailable', operation,
  // shareState } for a repeat submission.
  async function executeIdempotentCreate(req, { namespace, requestId, source, apiCredential }) {
    const prepared = prepareCreateInput(req.body);

    if (prepared.error) {
      throw new CreateValidationError(prepared.error);
    }

    const requestHmac = computeRequestHmac({
      action: 'share.create',
      targetId: null,
      presence: prepared.presence,
      values: prepared.values
    });

    return pageRepository.createIdempotent({
      operation: {
        actorNamespace: namespace,
        requestId,
        action: 'share.create',
        targetId: null,
        requestHmac
      },
      apiCredential,
      revisionMeta: createRevisionMeta(apiCredential),
      audit: {
        action: 'page.create',
        details: JSON.stringify({
          codeType: prepared.values.codeType,
          isProtected: prepared.values.isProtected,
          source,
          requestId
        }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      },
      prepare: async () => {
        const derived = await deriveCreateValues(prepared);
        const id = generateId();
        return {
          page: { ...derived.pageData, id },
          result: createResultReceipt(derived, id)
        };
      }
    });
  }

  // Turns a repository outcome into the create response payload, or null
  // when the original result is no longer available (the caller answers
  // 410). Replay payloads come from the encrypted receipt — the ORIGINAL
  // result — re-checked against current state (parent spec §8):
  //   - result Share gone / record tombstoned → unavailable;
  //   - the result Revision's snapshot is gone (history storage cleared)
  //     → the version's title/description are withheld, and so is the
  //     password, which describes that protected version;
  //   - access policy changed since (unprotected now, or the access
  //     revision moved) → the generated password is NOT returned again;
  //     only an untouched policy gets it back, per "敏感字段先核对当前
  //     身份、目标和策略状态再决定是否重显".
  function createOutcomePayload(outcome) {
    if (!outcome) {
      return null;
    }

    if (outcome.outcome === 'created') {
      return { ...outcome.result };
    }

    if (outcome.outcome !== 'replayed' || !outcome.shareState || !outcome.operation) {
      return null;
    }

    let receipt = null;

    try {
      const decrypted = outcome.operation.receiptEncrypted
        ? decryptSecret(outcome.operation.receiptEncrypted)
        : null;
      receipt = decrypted ? JSON.parse(decrypted) : null;
    } catch {
      receipt = null;
    }

    if (!receipt || receipt.kind !== 'share.create' || !receipt.shareId) {
      return null;
    }

    const payload = { ...receipt };

    if (!outcome.shareState.revisionExists) {
      payload.title = null;
      payload.description = null;
      payload.password = null;
      return payload;
    }

    if (payload.password) {
      const policyIntact = outcome.shareState.isProtected
        && accessRevisionMatches(
          outcome.shareState.accessRevision,
          outcome.operation.resultAccessRevision
        );

      if (!policyIntact) {
        payload.password = null;
      }
    }

    return payload;
  }

  // Decrypts the stored receipt of a committed publish operation (T08/T09).
  // Receipts carry only the fields the original response needed — never a
  // content body and, for the save/restore actions, no secret material at
  // all — so a replay can return them verbatim as the operation's result.
  function operationReceipt(operation) {
    if (!operation || !operation.receiptEncrypted) {
      return null;
    }

    try {
      const decrypted = decryptSecret(operation.receiptEncrypted);
      return decrypted ? JSON.parse(decrypted) : null;
    } catch {
      return null;
    }
  }

  // Parses the access-state If-Match of an unpublish/republish request
  // into the pair the repository judges inside its transaction (T15):
  // the expected access revision when the tag is one concrete strong
  // ACCESS tag for this Share, or the missing marker otherwise. The tag
  // family is the state family — a content tag can never stand in for it
  // (parent spec #24 §7: the two operation families' tags are not
  // interchangeable), and weak tags, wildcards and lists are invalid,
  // never a match (§4). `digestValue` binds the caller's expectation
  // into the request digest (§8) exactly like the content helper below:
  // the revision itself, null when absent, or the raw malformed header,
  // so a byte-identical retry digests identically in any state.
  function accessPreconditionState(req, shareId) {
    const parsed = parseAccessIfMatch(req.get('if-match'), shareId);

    if (parsed.status === 'missing') {
      return {
        expectedAccessRevision: null,
        accessPreconditionMissing: true,
        digestValue: null
      };
    }

    if (parsed.status !== 'ok') {
      return {
        expectedAccessRevision: null,
        accessPreconditionMissing: false,
        digestValue: `invalid:${String(req.get('if-match'))}`
      };
    }

    return {
      expectedAccessRevision: parsed.revision,
      accessPreconditionMissing: false,
      digestValue: parsed.revision
    };
  }

  // Parses the content If-Match of a save/restore request into the triple
  // the repository judges inside its transaction (T09): the expected
  // revision when the tag is one concrete strong content tag, or the
  // missing/invalid markers otherwise. `digestValue` is what the request
  // digest binds as the caller's expected version (parent spec §8): the
  // revision itself, null when absent, or the raw malformed header, so a
  // retry reproduces the digest exactly while any other expectation —
  // including a now-current tag — is a different request.
  function contentPreconditionState(req, shareId) {
    const parsed = parseContentIfMatch(req.get('if-match'), shareId);

    if (parsed.status === 'missing') {
      return {
        expectedContentRevision: null,
        contentPreconditionMissing: true,
        contentPreconditionInvalid: false,
        digestValue: null
      };
    }

    if (parsed.status !== 'ok') {
      return {
        expectedContentRevision: null,
        contentPreconditionMissing: false,
        contentPreconditionInvalid: true,
        digestValue: `invalid:${String(req.get('if-match'))}`
      };
    }

    return {
      expectedContentRevision: parsed.revision,
      contentPreconditionMissing: false,
      contentPreconditionInvalid: false,
      digestValue: parsed.revision
    };
  }

  async function createPageFromInput(input, { apiCredential } = {}) {
    const prepared = prepareCreateInput(input);

    if (prepared.error) {
      return { error: prepared.error };
    }

    let derived;

    try {
      derived = await deriveCreateValues(prepared);
    } catch (error) {
      if (isCreateValidationError(error)) {
        return { error: error.message };
      }

      throw error;
    }

    const id = await createPageWithRetry(derived.pageData, {
      apiCredential,
      revisionMeta: createRevisionMeta(apiCredential)
    });
    const receipt = createResultReceipt(derived, id);

    return {
      error: null,
      id,
      password: receipt.password,
      isProtected: receipt.isProtected,
      codeType: receipt.codeType,
      title: receipt.title,
      description: receipt.description,
      expiresAt: receipt.expiresAt,
      markdownTheme: receipt.markdownTheme,
      contentRevision: receipt.contentRevision,
      contentEtag: receipt.contentEtag
    };
  }

  // History metadata for the v1 API (T14, issue #38): the dashboard
  // history shape without the management-time text renderings, plus the
  // `current` flag. The flag is derived ONLY from the currentRevision
  // the repository read in the same snapshot as the entries themselves,
  // so a response can never mark a Revision current that its own pointer
  // disagrees with.
  function apiRevisionMetaJson(record, currentRevision) {
    const revision = toContentRevisionString(record.revision);

    return {
      revision,
      createdAt: Number(record.created_at),
      source: record.source,
      actorType: record.actor_type,
      restoredFromRevision: record.restored_from_revision == null
        ? null
        : toContentRevisionString(record.restored_from_revision),
      purged: record.purged_at != null || record.html_content === null,
      purgedAt: record.purged_at == null ? null : Number(record.purged_at),
      current: currentRevision !== null && revision !== null && revision === currentRevision
    };
  }

  return {
    checkAccessPrecondition,
    ifNoneMatchMatches,
    instanceOrigin,
    isCreateValidationError,
    prepareCreateInput,
    deriveCreateValues,
    executeIdempotentCreate,
    createOutcomePayload,
    operationReceipt,
    accessPreconditionState,
    contentPreconditionState,
    createPageFromInput,
    apiRevisionMetaJson
  };
}

module.exports = {
  createShareOperations
};
