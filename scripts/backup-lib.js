'use strict';

// Shared helpers for the QuickShare full-database backup / restore / verify
// tooling (T03, issue #27). These scripts are operator tooling for isolated
// drills and disaster-recovery checks. They are not wired into the web app
// and never run against production by default: every database target must be
// on localhost, and database names must end in `_test` unless the operator
// explicitly passes `--allow-non-test`.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Every public table a complete QuickShare backup must account for. The
// snapshot records whatever tables actually exist and verification fails on
// any difference, so a future ticket that adds a table cannot silently drop
// out of backup coverage: the manifest comparison will flag it.
const KNOWN_TABLES = [
  'api_keys',
  'audit_logs',
  'pages',
  'quickshare_schema_migrations',
  'site_settings'
];

const PAGE_DIGEST_FIELDS = [
  'id',
  'html_content',
  'created_at',
  'password_hash',
  'encrypted_password',
  'is_protected',
  'code_type',
  'title',
  'description',
  'expires_at',
  'markdown_theme',
  'view_count',
  'is_favorite'
];

const API_KEY_DIGEST_FIELDS = [
  'id',
  'name',
  'key_hash',
  'key_prefix',
  'created_at',
  'last_used_at'
];

const AUDIT_DIGEST_FIELDS = [
  'id',
  'action',
  'page_id',
  'details',
  'ip',
  'created_at'
];

const SITE_SETTINGS_DIGEST_FIELDS = [
  'id',
  'homepage_password_required',
  'updated_at'
];

// Audit vocabulary that changes or destroys access credentials. `page.update`
// only counts when its recorded field list touches the access policy; T01
// advances access_revision for exactly these fields (passwordHash /
// encryptedPassword / isProtected / expiresAt).
const ACCESS_POLICY_FIELDS = ['passwordHash', 'encryptedPassword', 'isProtected', 'expiresAt'];

function toFlagName(optionName) {
  return `--${optionName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
}

// One strict argument parser shared by every backup script, so option
// handling cannot drift between them:
// - boolean options are bare flags and NEVER consume the following token;
// - string options accept `--name value` and `--name=value`, always
//   consuming exactly one value;
// - unknown options, stray positionals, missing values and duplicate
//   single-value options are hard errors.
function parseArgs(argv, spec) {
  const byFlag = new Map();

  for (const [name, rule] of Object.entries(spec)) {
    byFlag.set(toFlagName(name), { name, rule });
  }

  const options = {};

  for (const [name, rule] of Object.entries(spec)) {
    if (rule.type === 'boolean') {
      options[name] = rule.default === true;
    } else if (rule.multiple) {
      options[name] = [];
    } else if (rule.default !== undefined) {
      options[name] = rule.default;
    } else {
      options[name] = undefined;
    }
  }

  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equalsAt = token.startsWith('--') ? token.indexOf('=') : -1;
    const flag = equalsAt === -1 ? token : token.slice(0, equalsAt);
    const entry = byFlag.get(flag);

    if (!entry) {
      throw new Error(`Unknown option: ${token}`);
    }

    const { name, rule } = entry;

    if (rule.type === 'boolean') {
      if (equalsAt !== -1) {
        throw new Error(`Option ${flag} is a boolean flag and does not take a value`);
      }
      options[name] = true;
      seen.add(name);
      continue;
    }

    let value;

    if (equalsAt !== -1) {
      value = token.slice(equalsAt + 1);
    } else {
      index += 1;
      value = argv[index];

      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Option ${flag} requires a value`);
      }
    }

    if (value === '') {
      throw new Error(`Option ${flag} requires a non-empty value`);
    }

    if (rule.multiple) {
      options[name].push(value);
    } else {
      if (seen.has(name)) {
        throw new Error(`Option ${flag} may only be given once`);
      }
      options[name] = value;
    }
    seen.add(name);
  }

  for (const [name, rule] of Object.entries(spec)) {
    if (rule.required && (options[name] === undefined || options[name] === '')) {
      throw new Error(`Missing required option: ${toFlagName(name)}`);
    }
  }

  return options;
}

function parseDatabaseUrl(databaseUrl) {
  let url;

  try {
    url = new URL(databaseUrl);
  } catch (error) {
    throw new Error('Database URL must be a valid URL');
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Database URL must use postgres:// or postgresql://');
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database,
    username: decodeURIComponent(url.username || '')
  };
}

const LOCALHOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Guard shared by backup, restore, verify and the drill: the target must be
// a localhost database, and its name must end in `_test` unless the operator
// explicitly opted out with --allow-non-test.
function assertIsolatedDatabaseUrl(databaseUrl, { allowNonTest = false, purpose = 'database' } = {}) {
  const target = parseDatabaseUrl(databaseUrl);

  if (!LOCALHOSTS.has(target.host)) {
    throw new Error(`${purpose} must be on localhost (got host "${target.host}")`);
  }

  if (!target.database || !/^[A-Za-z0-9_]+$/.test(target.database)) {
    throw new Error(`${purpose} name is missing or contains unsupported characters`);
  }

  if (!target.database.endsWith('_test') && !allowNonTest) {
    throw new Error(
      `${purpose} "${target.database}" does not end in _test; pass --allow-non-test only for an explicitly intended non-test database`
    );
  }

  return target;
}

function resolvePgTool(toolName, { binDir, env = process.env } = {}) {
  const candidates = [];
  const requestedDir = binDir || env.QS_PG_BIN_DIR;

  if (requestedDir) {
    candidates.push(path.join(requestedDir, toolName));
  }

  const pathDirs = (env.PATH || '').split(path.delimiter).filter(Boolean);

  for (const dir of pathDirs) {
    candidates.push(path.join(dir, toolName));
  }

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (error) {
      // keep looking
    }
  }

  throw new Error(
    `Could not find ${toolName}. Install PostgreSQL client tools matching the database major version, or pass --pg-bin-dir / set QS_PG_BIN_DIR.`
  );
}

function runCommand(command, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: env || process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function pgToolMajorVersion(toolPath) {
  const result = await runCommand(toolPath, ['--version']);

  if (result.code !== 0) {
    throw new Error(`${path.basename(toolPath)} --version failed: ${result.stderr.trim()}`);
  }

  const match = result.stdout.match(/\b(\d+)\.(\d+)\b/);

  if (!match) {
    throw new Error(`Could not parse ${path.basename(toolPath)} version from: ${result.stdout.trim()}`);
  }

  return Number(match[1]);
}

// Build explicit connection arguments for pg_dump / pg_restore from a
// database URL. Passing host/port/user/dbname as separate options (and the
// password via PGPASSWORD) is deterministic across libpq builds, unlike
// handing the whole URL to PGDATABASE, which some builds treat as a plain
// database name and silently ignore.
function pgToolConnection(databaseUrl) {
  const url = new URL(databaseUrl);
  const args = [
    `--host=${url.hostname}`,
    `--port=${url.port ? Number(url.port) : 5432}`,
    `--username=${decodeURIComponent(url.username || '')}`,
    `--dbname=${decodeURIComponent(url.pathname.replace(/^\//, ''))}`
  ];
  const env = {};

  if (url.password) {
    env.PGPASSWORD = decodeURIComponent(url.password);
  }

  const sslmode = url.searchParams.get('sslmode');

  if (sslmode) {
    env.PGSSLMODE = sslmode;
  }

  return { args, env };
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// node-postgres returns BIGINT as string and INTEGER as number; normalize so
// digests are stable no matter which driver produced the row. Strings pass
// through untouched, which keeps 64-bit values such as access_revision
// 9007199254740993 exact (a JS number could not represent them).
function canonicalValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function rowDigest(row, fields) {
  return sha256Hex(JSON.stringify(fields.map(field => canonicalValue(row[field]))));
}

function buildSection(rows, fields, keyField) {
  const digests = {};
  const ordered = [...rows].sort((left, right) => (
    String(left[keyField]).localeCompare(String(right[keyField]))
  ));

  for (const row of ordered) {
    digests[String(row[keyField])] = rowDigest(row, fields);
  }

  const aggregateDigest = sha256Hex(
    ordered.map(row => digests[String(row[keyField])]).join('\n')
  );

  return { count: rows.length, aggregateDigest, digests };
}

// Collect a comparable snapshot of everything a complete backup must cover.
// `query` is any node-postgres compatible query function (pool or client).
// Returns { snapshot, pageRows, auditRows }: the snapshot is JSON-safe and
// contains digests only (never password hashes, encrypted passwords or key
// hashes); the raw rows stay in memory for capability checks and are never
// written to disk by this module.
async function collectSnapshot(query) {
  const serverResult = await query(
    "SELECT current_setting('server_version') AS version, current_setting('server_version_num') AS version_num"
  );
  const serverVersion = serverResult.rows[0].version;
  const serverMajor = Math.floor(Number(serverResult.rows[0].version_num) / 10000);

  const tablesResult = await query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const tables = tablesResult.rows.map(row => row.table_name);

  const columnsResult = await query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, column_name
  `);
  const columns = {};

  for (const row of columnsResult.rows) {
    if (!columns[row.table_name]) {
      columns[row.table_name] = [];
    }
    columns[row.table_name].push(row.column_name);
  }

  const counts = {};

  for (const table of tables) {
    const countResult = await query(`SELECT COUNT(*)::text AS count FROM public."${table}"`);
    counts[table] = countResult.rows[0].count;
  }

  let ledger = [];

  if (tables.includes('quickshare_schema_migrations')) {
    const ledgerResult = await query(`
      SELECT version, name, checksum, applied_at
      FROM public.quickshare_schema_migrations
      ORDER BY version
    `);
    ledger = ledgerResult.rows.map(row => ({
      version: row.version,
      name: row.name,
      checksum: row.checksum,
      appliedAt: canonicalValue(row.applied_at)
    }));
  }

  const hasAccessRevision = (columns.pages || []).includes('access_revision');
  const pageFields = hasAccessRevision
    ? [...PAGE_DIGEST_FIELDS, 'access_revision']
    : PAGE_DIGEST_FIELDS;

  const pageResult = await query('SELECT * FROM public.pages ORDER BY id');
  const pageRows = pageResult.rows;
  const pages = buildSection(pageRows, pageFields, 'id');
  pages.hasAccessRevision = hasAccessRevision;

  if (hasAccessRevision) {
    pages.accessRevisions = {};

    for (const row of pageRows) {
      pages.accessRevisions[row.id] = canonicalValue(row.access_revision);
    }
  }

  const apiKeyResult = await query('SELECT * FROM public.api_keys ORDER BY id');
  const apiKeys = buildSection(apiKeyResult.rows, API_KEY_DIGEST_FIELDS, 'id');

  const auditResult = await query('SELECT * FROM public.audit_logs ORDER BY id');
  const auditRows = auditResult.rows;
  const audit = buildSection(auditRows, AUDIT_DIGEST_FIELDS, 'id');
  const lastAudit = auditRows[auditRows.length - 1];
  audit.highWaterId = lastAudit ? canonicalValue(lastAudit.id) : null;
  audit.highWaterCreatedAt = lastAudit ? canonicalValue(lastAudit.created_at) : null;

  const settingsResult = await query('SELECT * FROM public.site_settings ORDER BY id');
  // publishing_writes_paused arrives with migration 005 (T04); mirror the
  // access_revision treatment and only digest it when the column exists,
  // so legacy 001-003 fixtures keep their historical digests.
  const hasPublishingWritesPaused = (columns.site_settings || []).includes('publishing_writes_paused');
  const siteSettingsFields = hasPublishingWritesPaused
    ? [...SITE_SETTINGS_DIGEST_FIELDS, 'publishing_writes_paused']
    : SITE_SETTINGS_DIGEST_FIELDS;
  const siteSettings = buildSection(settingsResult.rows, siteSettingsFields, 'id');
  const settingsRow = settingsResult.rows[0];
  siteSettings.homepagePasswordRequired = settingsRow
    ? settingsRow.homepage_password_required === true
    : null;
  siteSettings.publishingWritesPaused = hasPublishingWritesPaused && settingsRow
    ? settingsRow.publishing_writes_paused === true
    : null;

  const snapshot = {
    serverVersion,
    serverMajor,
    tables,
    columns,
    counts,
    ledger,
    pages,
    apiKeys,
    audit: {
      count: audit.count,
      aggregateDigest: audit.aggregateDigest,
      digests: audit.digests,
      highWaterId: audit.highWaterId,
      highWaterCreatedAt: audit.highWaterCreatedAt
    },
    siteSettings
  };

  return { snapshot, pageRows, auditRows };
}

// The manifest is the public record of a backup: it must let an operator
// verify a restore without containing any secret material. Only digests,
// counts and non-secret metadata are copied in.
function buildManifest({ snapshot, source, dump, restorePoint, backupDurationMs, createdAt }) {
  return {
    format: 'quickshare-full-backup',
    version: 1,
    createdAt,
    restorePoint,
    source: {
      host: source.host,
      port: source.port,
      database: source.database,
      serverVersion: snapshot.serverVersion,
      serverMajor: snapshot.serverMajor
    },
    dump: {
      file: dump.file,
      format: 'postgres-custom',
      sha256: dump.sha256,
      bytes: dump.bytes
    },
    backupDurationMs,
    containsSecrets: false,
    note: 'Manifest contains digests and metadata only. Password hashes, encrypted passwords, API key hashes and runtime secrets stay inside the private dump file and the separately stored runtime secret material.',
    snapshot
  };
}

function compareSections(label, expected, actual, failures) {
  if (!actual) {
    failures.push(`${label}: section missing in restored database`);
    return;
  }

  if (expected.count !== actual.count) {
    failures.push(`${label}: row count differs (backup ${expected.count}, restored ${actual.count})`);
  }

  const expectedDigests = expected.digests || {};
  const actualDigests = actual.digests || {};

  for (const key of Object.keys(expectedDigests)) {
    if (!(key in actualDigests)) {
      failures.push(`${label}: row ${key} missing after restore`);
    } else if (actualDigests[key] !== expectedDigests[key]) {
      failures.push(`${label}: row ${key} content differs after restore`);
    }
  }

  for (const key of Object.keys(actualDigests)) {
    if (!(key in expectedDigests)) {
      failures.push(`${label}: unexpected row ${key} present after restore`);
    }
  }
}

// Compare the snapshot recorded in a backup manifest against a snapshot
// collected from a restored database. Returns a list of human-readable
// failures; an empty list means the restore is byte-for-byte equivalent at
// the row level for every covered table.
function compareSnapshots(expected, actual) {
  const failures = [];

  if (expected.serverMajor !== actual.serverMajor) {
    failures.push(
      `server major version differs (backup ${expected.serverMajor}, restored ${actual.serverMajor})`
    );
  }

  const expectedTables = [...expected.tables].sort();
  const actualTables = [...actual.tables].sort();

  for (const table of expectedTables) {
    if (!actualTables.includes(table)) {
      failures.push(`table ${table} missing after restore`);
    }
  }

  for (const table of actualTables) {
    if (!expectedTables.includes(table)) {
      failures.push(`table ${table} present after restore but not accounted for by the backup`);
    }
  }

  for (const table of expectedTables) {
    if (!actualTables.includes(table)) {
      continue;
    }
    const expectedColumns = expected.columns[table] || [];
    const actualColumns = actual.columns[table] || [];

    for (const column of expectedColumns) {
      if (!actualColumns.includes(column)) {
        failures.push(`column ${table}.${column} missing after restore`);
      }
    }

    for (const column of actualColumns) {
      if (!expectedColumns.includes(column)) {
        failures.push(`column ${table}.${column} present after restore but not in the backup`);
      }
    }

    if (String(expected.counts[table]) !== String(actual.counts[table])) {
      failures.push(
        `table ${table} row count differs (backup ${expected.counts[table]}, restored ${actual.counts[table]})`
      );
    }
  }

  const ledgerKey = row => `${row.version}:${row.name}:${row.checksum}`;
  const expectedLedger = expected.ledger.map(ledgerKey);
  const actualLedger = actual.ledger.map(ledgerKey);

  if (JSON.stringify(expectedLedger) !== JSON.stringify(actualLedger)) {
    failures.push(
      `migration ledger differs (backup [${expectedLedger.join(', ')}], restored [${actualLedger.join(', ')}])`
    );
  }

  compareSections('pages', expected.pages, actual.pages, failures);
  compareSections('api_keys', expected.apiKeys, actual.apiKeys, failures);
  compareSections('audit_logs', expected.audit, actual.audit, failures);
  compareSections('site_settings', expected.siteSettings, actual.siteSettings, failures);

  if (expected.pages.hasAccessRevision) {
    if (!actual.pages.hasAccessRevision) {
      failures.push('pages.access_revision column missing after restore');
    } else {
      const expectedRevisions = expected.pages.accessRevisions || {};
      const actualRevisions = actual.pages.accessRevisions || {};

      for (const [pageId, revision] of Object.entries(expectedRevisions)) {
        if (actualRevisions[pageId] !== revision) {
          failures.push(
            `pages ${pageId} access_revision differs (backup ${revision}, restored ${actualRevisions[pageId]})`
          );
        }
      }
    }
  }

  if (expected.audit.highWaterId !== actual.audit.highWaterId
    || expected.audit.highWaterCreatedAt !== actual.audit.highWaterCreatedAt) {
    failures.push('audit high-water mark differs after restore');
  }

  return failures;
}

// Scan audit rows for events that revoked access or changed the access
// policy of a Share, plus deletions. This is evidence about the snapshot's
// own history only: legacy protect writes predate audit coverage, so an
// empty result never proves that no revocation ever happened.
function detectAccessRevocations(auditRows) {
  const events = [];

  for (const row of auditRows) {
    const base = {
      auditId: canonicalValue(row.id),
      pageId: row.page_id || null,
      at: canonicalValue(row.created_at)
    };

    if (row.action === 'page.access.revoke') {
      events.push({ ...base, type: 'access-revoke' });
      continue;
    }

    if (row.action === 'page.update') {
      let fields = [];

      try {
        const details = JSON.parse(row.details || '{}');
        fields = Array.isArray(details.fields) ? details.fields : [];
      } catch (error) {
        fields = [];
      }

      const policyFields = fields.filter(field => ACCESS_POLICY_FIELDS.includes(field));

      if (policyFields.length > 0) {
        events.push({ ...base, type: 'access-policy-change', fields: policyFields });
      }
      continue;
    }

    if (row.action === 'page.delete') {
      events.push({ ...base, type: 'page-delete' });
      continue;
    }

    if (row.action === 'page.delete.batch') {
      let ids = [];

      try {
        const details = JSON.parse(row.details || '{}');
        ids = Array.isArray(details.ids) ? details.ids : [];
      } catch (error) {
        ids = [];
      }

      events.push({ ...base, type: 'page-delete-batch', pageIds: ids });
    }
  }

  return events;
}

module.exports = {
  ACCESS_POLICY_FIELDS,
  KNOWN_TABLES,
  assertIsolatedDatabaseUrl,
  buildManifest,
  buildSection,
  canonicalValue,
  collectSnapshot,
  compareSnapshots,
  detectAccessRevocations,
  parseArgs,
  parseDatabaseUrl,
  pgToolConnection,
  pgToolMajorVersion,
  resolvePgTool,
  rowDigest,
  runCommand,
  sha256Hex
};
