function invalidApiKey() {
  return Object.assign(new Error('Invalid API key'), { code: 'INVALID_API_KEY', status: 401 });
}

function managedIdentity(record) {
  if (!record || !/^[1-9][0-9]*$/.test(record.credential_version)) throw invalidApiKey();
  return Object.freeze({ credentialKind: 'managed', id: record.id, name: record.name, credentialVersion: record.credential_version });
}

module.exports = { invalidApiKey, managedIdentity };
