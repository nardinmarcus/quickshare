const test = require('node:test');
const assert = require('node:assert/strict');

const { createPostgresPool } = require('../../models/postgres-config');
const { runMigrations } = require('../../models/postgres-migrations');
const { PostgresPageRepository } = require('../../models/postgres-pages');
const { acquirePublishingWriteGate } = require('../../models/publishing');
const { hashSecret, verifySecret } = require('../../utils/security');
const {
  ApiKeyCredentialChangedError,
  isApiKeyCredentialChangedError
} = require('../../utils/apiKeyIdentity');
const { collectSnapshot, compareSnapshots } = require('../../scripts/backup-lib');

// Managed Key rotation and credential-version race protection against real
// Postgres (T05, issue #29). The guarantee — a request that verified the
// old secret cannot write after a rotation/delete committed — rests on
// transaction row locks, so it is proven here with independent pooled
// connections, never with two queries multiplexed over one client.
//
// This file uses its own `quickshare_apikeys_test` database, created and
// dropped by the file itself.

const connectionString = process.env.POSTGRES_TEST_URL;

if (!connectionString) {
  throw new Error('POSTGRES_TEST_URL is required for Postgres integration tests');
}

const testUrl = new URL(connectionString);
const databaseName = testUrl.pathname.replace(/^\//, '');
const isLocalHost = ['127.0.0.1', 'localhost', '::1'].includes(testUrl.hostname);

if (!isLocalHost || !databaseName.endsWith('_test')) {
  throw new Error('POSTGRES_TEST_URL must use localhost and a database ending in _test');
}

const APIKEYS_DB = 'quickshare_apikeys_test';

function serverBaseUrl(database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

const apikeysUrl = serverBaseUrl(APIKEYS_DB);

const env = {
  POSTGRES_SSL: 'false',
  POSTGRES_STATEMENT_TIMEOUT_MS: '9000',
  POSTGRES_QUERY_TIMEOUT_MS: '9000',
  POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS: '60000',
  POSTGRES_CONNECTION_TIMEOUT_MS: '5000'
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let adminPool;
let repository;

async function resetState() {
  await repository.pool.query('DELETE FROM public.pages');
  await repository.pool.query('DELETE FROM public.audit_logs');
  await repository.pool.query('DELETE FROM public.api_keys');
  await repository.pool.query(
    'UPDATE public.site_settings SET publishing_writes_paused = false, homepage_password_required = true WHERE id = 1'
  );
}

async function seedKey(id, secret) {
  return repository.createApiKey({
    id,
    name: `Key ${id}`,
    keyHash: await hashSecret(secret),
    keyPrefix: `qs.${id.slice(0, 8)}…`,
    createdAt: Date.now()
  });
}

function pageRow(id) {
  return {
    id,
    htmlContent: `<h1>${id}</h1>`,
    createdAt: Date.now(),
    passwordHash: null,
    encryptedPassword: null,
    isProtected: false,
    codeType: 'html',
    title: id,
    description: null,
    expiresAt: null,
    markdownTheme: null
  };
}

test.before(async () => {
  adminPool = createPostgresPool(serverBaseUrl('postgres'), { env, max: 1 });
  await adminPool.query(`DROP DATABASE IF EXISTS ${APIKEYS_DB}`);
  await adminPool.query(`CREATE DATABASE ${APIKEYS_DB}`);

  repository = new PostgresPageRepository(apikeysUrl, env);
  await runMigrations(repository.pool, { logger: { info() {} } });
});

test.after(async () => {
  await repository.pool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS ${APIKEYS_DB}`);
  await adminPool.end();
});

test.beforeEach(async () => {
  await resetState();
});

test('migration 006 adds credential_version as BIGINT defaulting to 1', async () => {
  const column = await repository.pool.query(`
    SELECT data_type, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'api_keys' AND column_name = 'credential_version'
  `);
  assert.equal(column.rows.length, 1);
  assert.equal(column.rows[0].data_type, 'bigint');

  // A row written without the column (pre-006 writer shape) reads back 1.
  await repository.pool.query(
    `INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at)
     VALUES ('legacy-row', 'Legacy row', 'hash', 'qs.legacy…', $1)`,
    [Date.now()]
  );
  const stored = await repository.getApiKeyById('legacy-row');
  assert.equal(stored.credential_version, '1');

  const created = await seedKey('schema-key', 'schema-secret-123456');
  assert.equal(created.credential_version, '1');
  assert.equal(created.key_hash, undefined);
});

test('rotation keeps the logical Key, replaces the secret, and advances the version', async () => {
  const created = await seedKey('rotate-key', 'rotate-secret-original');
  const before = await repository.getApiKeyById('rotate-key');

  const newHash = await hashSecret('rotate-secret-replacement');
  const rotated = await repository.rotateApiKey('rotate-key', {
    keyHash: newHash,
    keyPrefix: 'qs.rotate-…'
  });

  assert.equal(rotated.id, created.id);
  assert.equal(rotated.name, created.name);
  assert.equal(rotated.created_at, created.created_at);
  assert.equal(rotated.credential_version, '2');
  assert.equal(rotated.key_hash, undefined);

  const after = await repository.getApiKeyById('rotate-key');
  assert.equal(after.key_hash, newHash);
  assert.notEqual(after.key_hash, before.key_hash);
  assert.equal(await verifySecret('rotate-secret-replacement', after.key_hash), true);
  assert.equal(await verifySecret('rotate-secret-original', after.key_hash), false);

  const rotatedAgain = await repository.rotateApiKey('rotate-key', {
    keyHash: await hashSecret('rotate-secret-third'),
    keyPrefix: 'qs.rotate-…'
  });
  assert.equal(rotatedAgain.credential_version, '3');

  assert.equal(await repository.rotateApiKey('missing-key', {
    keyHash: newHash,
    keyPrefix: 'qs.missing…'
  }), null);
});

test('a write verified before rotation commits is refused and stores nothing', async () => {
  await seedKey('race-rotate-key', 'race-rotate-secret-1');
  // The credential exactly as authentication recorded it: version 1.
  const verifiedCredential = { type: 'managed', keyId: 'race-rotate-key', credentialVersion: '1' };

  // The owner rotates on another connection and commits first.
  await repository.rotateApiKey('race-rotate-key', {
    keyHash: await hashSecret('race-rotate-secret-2'),
    keyPrefix: 'qs.race-rot…'
  });

  await assert.rejects(
    repository.create(pageRow('race-rotate-page'), { apiCredential: verifiedCredential }),
    error => error instanceof ApiKeyCredentialChangedError
      && isApiKeyCredentialChangedError(error)
      && error.code === 'api_key_credential_changed'
  );
  assert.equal(await repository.getById('race-rotate-page'), null);

  // The same write carrying the current version succeeds.
  await repository.create(pageRow('race-rotate-page'), {
    apiCredential: { type: 'managed', keyId: 'race-rotate-key', credentialVersion: '2' }
  });
  assert.ok(await repository.getById('race-rotate-page'));
});

test('a write verified before the Key was deleted is refused and stores nothing', async () => {
  await seedKey('race-delete-key', 'race-delete-secret-1');
  const verifiedCredential = { type: 'managed', keyId: 'race-delete-key', credentialVersion: '1' };

  assert.equal(await repository.deleteApiKey('race-delete-key'), true);

  await assert.rejects(
    repository.create(pageRow('race-delete-page'), { apiCredential: verifiedCredential }),
    error => error.code === 'api_key_credential_changed'
  );
  assert.equal(await repository.getById('race-delete-page'), null);
});

test('an in-flight write holding the Key lock makes rotation wait, then rotation wins for later writes', async () => {
  await seedKey('race-lock-key', 'race-lock-secret-1');
  const client = await repository.pool.connect();

  try {
    await client.query('BEGIN');
    // The same steps repository.create performs, held open: maintenance
    // gate first, then the Key row lock, then the recheck, then the write.
    await acquirePublishingWriteGate(client);
    const locked = await client.query(
      'SELECT credential_version::text AS credential_version FROM api_keys WHERE id = $1 FOR UPDATE',
      ['race-lock-key']
    );
    assert.equal(locked.rows[0].credential_version, '1');
    await client.query(
      `INSERT INTO pages (id, html_content, created_at, is_protected, code_type, title, access_revision)
       VALUES ($1, '<h1>race-lock-page</h1>', $2, 0, 'html', 'race-lock-page', 1)`,
      ['race-lock-page', Date.now()]
    );

    // Rotation on a separate pooled connection must block on the Key row
    // lock until the in-flight write commits — it can neither slip in
    // underneath nor fail the write.
    let rotationSettled = false;
    const rotationPromise = repository.rotateApiKey('race-lock-key', {
      keyHash: await hashSecret('race-lock-secret-2'),
      keyPrefix: 'qs.race-loc…'
    }).then(result => {
      rotationSettled = true;
      return result;
    });

    await sleep(400);
    assert.equal(rotationSettled, false);

    await client.query('COMMIT');

    const rotated = await rotationPromise;
    assert.equal(rotated.credential_version, '2');
  } finally {
    client.release();
  }

  // The in-flight write committed; later writes with the old version are
  // refused, and the new version writes normally.
  assert.ok(await repository.getById('race-lock-page'));
  await assert.rejects(
    repository.create(pageRow('race-lock-late-page'), {
      apiCredential: { type: 'managed', keyId: 'race-lock-key', credentialVersion: '1' }
    }),
    error => error.code === 'api_key_credential_changed'
  );
  await repository.create(pageRow('race-lock-late-page'), {
    apiCredential: { type: 'managed', keyId: 'race-lock-key', credentialVersion: '2' }
  });
  assert.ok(await repository.getById('race-lock-late-page'));
});

test('legacy credentials and session writes are not subject to the managed-Key recheck', async () => {
  await repository.create(pageRow('legacy-credential-page'), {
    apiCredential: { type: 'legacy', keyId: null, name: null, credentialVersion: null }
  });
  assert.ok(await repository.getById('legacy-credential-page'));

  await repository.create(pageRow('no-credential-page'));
  assert.ok(await repository.getById('no-credential-page'));
});

test('backup snapshots cover credential_version exactly and tampering is named', async () => {
  await seedKey('backup-key', 'backup-secret-123456');
  await repository.pool.query(
    "UPDATE public.api_keys SET credential_version = 9 WHERE id = 'backup-key'"
  );

  const query = (text, params) => repository.pool.query(text, params);
  const { snapshot } = await collectSnapshot(query);

  assert.equal(snapshot.apiKeys.hasCredentialVersion, true);
  assert.equal(snapshot.apiKeys.credentialVersions['backup-key'], '9');
  assert.deepEqual(compareSnapshots(snapshot, snapshot), []);

  await repository.pool.query(
    "UPDATE public.api_keys SET credential_version = 10 WHERE id = 'backup-key'"
  );
  const { snapshot: tampered } = await collectSnapshot(query);
  const failures = compareSnapshots(snapshot, tampered);
  assert.ok(
    failures.some(failure => failure.includes('api_keys backup-key credential_version differs')),
    `expected a credential_version failure, got: ${failures.join('; ')}`
  );
});
