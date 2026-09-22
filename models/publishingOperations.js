// SharePublishing orchestration for idempotent creation (#24 §8, #32).
//
// Digest-before-randomness is the core invariant: the request digest covers
// the normalized input (action, target, field presence and values) and is
// computed BEFORE any random Share id, generated password, timestamp or
// time-derived title exists, so a retried operation hashes identically.
// Randomness and time exist only inside executeNormalizedCreate.

const { generateId } = require('../utils/security');
const {
  isvalidRequestId,
  operationRequestDigest,
  namespaceKind,
  encodeOperationReceipt,
  decodeOperationReceipt
} = require('../utils/publishingOperation');
const { normalizeTitle, derivePageTitle } = require('../utils/pageTitle');
const { resolveMarkdownThemeId } = require('../utils/markdownThemeCatalog');
const {
  DEFAULT_PASSWORD_LENGTH,
  generateNumericPassword,
  hashSecret,
  encryptSecret,
  parseCustomPassword
} = require('../utils/security');
const { CONTENT_TYPES } = require('../utils/apiCapabilities');

const VALID_CODE_TYPES = new Set(CONTENT_TYPES);
// Kept identical to the original single expiry rejection message: callers
// cannot and should not distinguish "malformed" from "not in the future".
const EXPIRY_ERROR = '到期时间必须晚于当前时间';

function normalizeInputCodeType(content, requestedCodeType) {
  if (VALID_CODE_TYPES.has(requestedCodeType)) {
    return requestedCodeType;
  }
  // Detection stays lazy: codeDetector is required on demand to avoid a
  // cycle through contentRenderer in module load order.
  const { detectCodeType } = require('../utils/codeDetector');
  const detectedType = detectCodeType(content);
  return VALID_CODE_TYPES.has(detectedType) ? detectedType : 'html';
}

/**
 * Pure validation + normalization: no Date.now(), no randomness. The
 * time-dependent expiry check ("must be in the future") deliberately lives in
 * executeNormalizedCreate so a committed request whose expiry has since
 * passed still replays as a success instead of failing like a fresh request.
 */
function normalizeCreateInput(input) {
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

  let customPassword;
  customPassword = parseCustomPassword(requestedPassword);
  if (customPassword.error) {
    return { error: customPassword.error };
  }

  let expiry = null;
  if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') {
    const value = Number(expiresAt);
    if (!Number.isSafeInteger(value)) {
      return { error: EXPIRY_ERROR };
    }
    expiry = value;
  }

  const normalizedCodeType = normalizeInputCodeType(htmlContent, codeType);
  const explicitTitle = title === undefined || title === null ? '' : normalizeTitle(String(title));
  const normalizedDescription = description === undefined || description === null
    ? null
    : String(description).trim() || null;
  const resolvedTheme = normalizedCodeType === 'markdown'
    ? resolveMarkdownThemeId(markdownTheme)
    : null;

  // #24 L211: the digest covers field PRESENCE as well as normalized values.
  // Presence covers BUSINESS fields only — CSRF tokens, transport controls
  // and identity secrets never enter the digest. Values keep the exact same
  // normalization as execution, so equivalent normalized values still build
  // identical RESULTS; presence just makes absent-vs-explicit literal
  // requests distinguishable as the approved contract requires.
  const presence = {
    htmlContent: true,
    codeType: codeType !== undefined,
    title: title !== undefined,
    description: description !== undefined,
    expiresAt: expiresAt !== undefined,
    isProtected: isProtected !== undefined,
    password: customPassword.provided,
    markdownTheme: markdownTheme !== undefined
  };

  const fields = {
    htmlContent,
    codeType: normalizedCodeType,
    title: explicitTitle || null,
    description: normalizedDescription,
    expiresAt: expiry,
    isProtected: Boolean(isProtected),
    password: customPassword.provided ? customPassword.value : null,
    markdownTheme: resolvedTheme
  };

  return { error: null, fields, presence };
}

function createRequestDigest(fields, { action = 'create', targetId = null, presence = null } = {}) {
  // The canonical digest payload includes normalized values plus, when the
  // caller provides them, the business-field presence map. Clone operations
  // carry no field map (action+target fully identify them).
  return operationRequestDigest({ action, targetId, fields, ...(presence ? { presence } : {}) });
}

function validatePublishingRequestId(value, { INVALID_REQUEST_ID_MESSAGE: message } = {}) {
  if (value === undefined || value === null || value === '') {
    return { provided: false, error: null };
  }
  if (!isvalidRequestId(value)) {
    return { provided: true, error: message || '请求标识必须为 16-128 位字母、数字、短横线或下划线' };
  }
  return { provided: true, error: null, requestId: value };
}

/**
 * Creates a Share with collision-safe id retries. The id is generated HERE —
 * after the caller computed the request digest — so retries of the same
 * operation stay digest-identical.
 */
async function createPageWithUniqueId(repository, data) {
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = generateId();
    try {
      await repository.create({ ...data, id });
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

/**
 * Executes a normalized creation. Called only on a lookup miss: randomness
 * (Share id, generated password) and time (createdAt, time-derived fallback
 * title) are generated HERE, after the digest was already computed.
 */
async function executeNormalizedCreate(repository, fields, provenance = {}) {
  const createdAt = Date.now();

  if (fields.expiresAt !== null && fields.expiresAt <= createdAt) {
    return { error: EXPIRY_ERROR };
  }

  const pageTitle = fields.title || derivePageTitle(fields.htmlContent, fields.codeType, null, createdAt);
  const password = fields.isProtected
    ? (fields.password !== null ? fields.password : generateNumericPassword(DEFAULT_PASSWORD_LENGTH))
    : null;
  const passwordHash = password ? await hashSecret(password) : null;
  const encryptedPassword = password ? encryptSecret(password) : null;

  const id = await createPageWithUniqueId(repository, {
    htmlContent: fields.htmlContent,
    passwordHash,
    encryptedPassword,
    isProtected: Boolean(password),
    codeType: fields.codeType,
    title: pageTitle,
    description: fields.description,
    createdAt,
    expiresAt: fields.expiresAt,
    markdownTheme: fields.markdownTheme,
    actorSource: provenance.actorSource,
    actorIdentity: provenance.actorIdentity
  }, repository);

  const created = await repository.getById(id);
  if (!created) {
    throw new Error('Created Share disappeared inside its own transaction');
  }

  return {
    error: null,
    id,
    password,
    isProtected: Boolean(password),
    codeType: fields.codeType,
    title: pageTitle,
    description: fields.description,
    expiresAt: fields.expiresAt,
    markdownTheme: fields.markdownTheme,
    revision: String(created.current_revision),
    accessRevision: String(created.access_revision)
  };
}

/**
 * Builds the operation record that commits in the SAME transaction as the
 * Share, its baseline Revision and the audit entry.
 *
 * The encrypted receipt always carries the ORIGINAL creation result metadata
 * (codeType/title/description/expiresAt/markdownTheme/isProtected) so a
 * replay can confirm exactly what was committed — even long after the owner
 * edited the live Share — without ever exposing the owner's later content.
 * The generated password (when one exists) is the sensitive member of the
 * same encrypted receipt. Record payloads never contain the request body.
 */
function buildCreationOperationRecord({
  actorNamespace,
  requestId,
  requestDigest,
  result,
  createdAt = Date.now()
}) {
  const receipt = {
    isProtected: result.isProtected,
    codeType: result.codeType,
    title: result.title,
    description: result.description,
    expiresAt: result.expiresAt === undefined ? null : result.expiresAt,
    markdownTheme: result.markdownTheme
  };
  if (result.password) {
    receipt.password = result.password;
  }

  return {
    actor_namespace: actorNamespace,
    request_id: requestId,
    action: 'create',
    request_digest: requestDigest,
    target_id: null,
    result_share_id: result.id,
    result_revision: result.revision,
    result_access_revision: result.accessRevision,
    receipt_encrypted: encodeOperationReceipt(receipt),
    created_at: createdAt
  };
}

/**
 * Classifies a lookup hit. Returned shapes:
 *   { kind: 'conflict' }             — same request id, different input → 409
 *   { kind: 'result-unavailable' }   — tombstoned / deleted / revision gone → 410
 *   { kind: 'replay', result, receiptPassword } — confirmed original result → 200
 *
 * Replay confirms the ORIGINAL committed result: every response metadata
 * field comes from the encrypted receipt (the result as committed), never
 * from the live Share row — create replays must not become a channel for
 * reading the owner's later edits. Per #24 §8 the availability of the result
 * Share AND its committed Revision is re-checked first; anything missing
 * answers 410 without leaking that version's metadata and never rebuilds.
 * The access-policy re-check only decides whether the sensitive generated
 * password may be returned; it does not select which metadata is shown.
 */
async function classifyOperationReplay(repository, { record, requestDigest }) {
  if (record.request_digest !== requestDigest) {
    return { kind: 'conflict' };
  }
  if (record.deleted_at !== null && record.deleted_at !== undefined) {
    return { kind: 'result-unavailable' };
  }

  const page = await repository.getById(record.result_share_id);
  if (!page) {
    return { kind: 'result-unavailable' };
  }

  // Result Revision availability (#24 §8: Share/Revision existence is
  // re-confirmed before replay). A missing committed revision means the
  // original result is no longer confirmable — 410, no metadata, no rebuild.
  const revisionRow = await repository.getContentRevision(record.result_share_id, String(record.result_revision));
  if (!revisionRow) {
    return { kind: 'result-unavailable' };
  }

  if (record.action === 'clone') {
    // Clone results carry no receipt and no creation metadata; confirming the
    // committed clone only needs the Share + its result revision.
    return { kind: 'replay', cloneShareId: record.result_share_id, result: null, receiptPassword: null };
  }

  const receipt = decodeOperationReceipt(record.receipt_encrypted);
  if (!receipt || typeof receipt !== 'object') {
    // Without the committed receipt the original result cannot be reproduced
    // faithfully — refuse instead of serving live-row metadata.
    return { kind: 'result-unavailable' };
  }

  const accessUnchanged = String(page.access_revision) === String(record.result_access_revision);
  const receiptPassword = receipt.password
    && accessUnchanged
    && page.is_protected === 1
    ? receipt.password
    : null;

  return {
    kind: 'replay',
    result: {
      id: record.result_share_id,
      isProtected: Boolean(receipt.isProtected),
      codeType: receipt.codeType,
      title: receipt.title,
      description: receipt.description,
      expiresAt: receipt.expiresAt === undefined ? null : receipt.expiresAt,
      markdownTheme: receipt.markdownTheme
    },
    receiptPassword
  };
}

/**
 * Metadata-only projection for operation status endpoints. No receipt, no
 * body, no title/description/password ever passes through here.
 */
function operationStatusProjection(record) {
  return {
    namespaceKind: namespaceKind(record.actor_namespace),
    action: record.action,
    status: (record.deleted_at === null || record.deleted_at === undefined) ? 'succeeded' : 'result-unavailable',
    shareId: record.result_share_id,
    revision: record.result_revision === null || record.result_revision === undefined
      ? null
      : String(record.result_revision),
    accessRevision: record.result_access_revision === null || record.result_access_revision === undefined
      ? null
      : String(record.result_access_revision),
    createdAt: Number(record.created_at)
  };
}

module.exports = {
  EXPIRY_ERROR,
  normalizeCreateInput,
  createRequestDigest,
  validatePublishingRequestId,
  createPageWithUniqueId,
  executeNormalizedCreate,
  buildCreationOperationRecord,
  classifyOperationReplay,
  operationStatusProjection
};
