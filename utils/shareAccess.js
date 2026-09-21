// Access revisions travel as canonical decimal strings, including above 2^53.
const MAX_REVISION = 9223372036854775807n;
function isAccessRevision(value) {
  return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= MAX_REVISION;
}
function accessError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.code = status === 428 ? 'ACCESS_PRECONDITION_REQUIRED' : status === 412 ? 'ACCESS_REVISION_CONFLICT' : 'INVALID_ACCESS_REVISION';
  return error;
}
function requireAccessRevision(value) {
  if (value === undefined) throw accessError(428, '请刷新 Share 后重新确认访问设置；未保存的输入已保留。');
  if (!isAccessRevision(value)) throw accessError(400, 'expectedAccessRevision must be a positive decimal string');
  return value;
}
function isAccessUpdate(options) {
  return options.isProtected !== undefined || options.expiresAt !== undefined || options.revokeAccess === true;
}
function assertAccessRevision(expected, current) {
  requireAccessRevision(expected);
  if (expected !== current) throw accessError(412, 'Share 访问设置已更改，请刷新后重新确认；未保存的输入已保留。');
}
module.exports = { isAccessRevision, requireAccessRevision, isAccessUpdate, assertAccessRevision, accessError };
