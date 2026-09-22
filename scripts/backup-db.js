#!/usr/bin/env node
'use strict';

/*
 * Native consistent backup for QuickShare PostgreSQL databases.
 *
 * This script produces a restorable, transactionally consistent native backup
 * (pg_dump custom format) plus a metadata manifest. It is the real-backup
 * counterpart of the metadata-only inventory JSON export.
 *
 * Safety guards:
 * - Target databases must be localhost and end in `_test` unless
 *   `--allow-non-test` is passed explicitly (owner-run production backups are
 *   a separately authorized operation; the flag is recorded in the manifest).
 * - The dump tool major version must match the server major version.
 * - Connection URLs are never written to manifests; they are redacted in logs.
 * - This script never loads `.env`; pass the URL explicitly per invocation.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { createPostgresPool } = require('../models/postgres-config');

const DUMP_FORMAT = 'custom';
const REDACTED_URL_MARKER = '***';

function redactUrl(connectionString) {
  try {
    const url = new URL(connectionString);
    if (url.password) {
      url.password = REDACTED_URL_MARKER;
    }
    // PostgreSQL also accepts credentials in query parameters, including a
    // percent-encoded password overriding the userinfo password.
    for (const key of [...url.searchParams.keys()]) {
      if (isSecretArgument(key)) url.searchParams.set(key, REDACTED_URL_MARKER);
    }
    return url.toString();
  } catch (error) {
    return '<invalid-url>';
  }
}

function isSecretArgument(name) {
  return /(?:password|secret|token|api[-_]?key)$/i.test(name);
}

// Log-only argv copy. Never pass this result to spawn: execution still needs
// the real credentials. Supports both --flag value and --flag=value, plus
// environment assignments used with container tools.
function redactCommandArgs(args) {
  let nextKind = null;
  const isUrlArgument = name => /(?:^|[-_])url$/i.test(name);
  return args.map(value => {
    const text = String(value);
    if (nextKind) {
      const kind = nextKind;
      nextKind = null;
      return kind === 'url' ? redactUrl(text) : REDACTED_URL_MARKER;
    }
    if (/^postgres(?:ql)?:\/\//i.test(text)) return redactUrl(text);
    const equalAt = text.indexOf('=');
    if (equalAt !== -1) {
      const name = text.slice(0, equalAt);
      if (isSecretArgument(name)) return `${name}=${REDACTED_URL_MARKER}`;
      const argument = text.slice(equalAt + 1);
      if (isUrlArgument(name) || /^postgres(?:ql)?:\/\//i.test(argument)) return `${name}=${redactUrl(argument)}`;
    }
    if (text.startsWith('--')) {
      if (isSecretArgument(text)) nextKind = 'secret';
      else if (isUrlArgument(text)) nextKind = 'url';
    }
    return text;
  });
}

function parseConnectionStringParts(connectionString) {
  const url = new URL(connectionString);

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Connection string must use postgres:// or postgresql://');
  }

  return {
    host: url.hostname,
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname.replace(/^\//, ''))
  };
}

function isLocalHost(hostname) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
}

/**
 * Fail-closed database guard: localhost only, database name must end in `_test`.
 * Returns true for an accepted test database, or a recorded bypass object when
 * `allowNonTest` is explicitly passed. Throws for anything else.
 */
function assertTestDatabaseUrl(connectionString, options = {}) {
  const parts = parseConnectionStringParts(connectionString);

  if (!parts.database) {
    throw new Error('Connection string must include a database name');
  }

  const isTestShaped = parts.database.endsWith('_test');

  if (isTestShaped && isLocalHost(parts.host)) {
    return true;
  }

  if (options.allowNonTest === true) {
    return { allowed: true, testGuardBypassed: true };
  }

  if (!isLocalHost(parts.host)) {
    throw new Error(`Refusing to continue: ${redactUrl(connectionString)} is not localhost. ` +
      'Only localhost databases are allowed here; pass --allow-non-test explicitly for an owner-authorized operation.');
  }

  throw new Error(`Refusing to continue: database "${parts.database}" does not end in _test. ` +
    'Only *_test databases are allowed without --allow-non-test.');
}

/**
 * Strips inherited credentials and database URLs from a child process env.
 * Values in `overrides` are applied afterwards (synthetic test values only).
 */
function sanitizeChildEnv(env = process.env, overrides = {}) {
  const forbidden = [
    'DATABASE_URL',
    'POSTGRES_URL',
    'DATABASE_URL_UNPOOLED',
    'POSTGRES_URL_NON_POOLING',
    'DATABASE_MIGRATION_URL',
    'SESSION_SECRET',
    'AUTH_SECRET',
    'AUTH_PASSWORD',
    'ADMIN_DASHBOARD_PASSWORD',
    'SHARE_API_KEY'
  ];
  const sanitized = { ...env };

  for (const key of forbidden) {
    delete sanitized[key];
  }

  return { ...sanitized, ...overrides };
}

function runCommand(argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function parsePostgresMajor(versionOutput) {
  const match = String(versionOutput || '').match(/\(PostgreSQL\)\s+(\d+)/);

  if (!match) {
    throw new Error(`Cannot parse PostgreSQL tool version from: ${String(versionOutput).slice(0, 120)}`);
  }

  return Number.parseInt(match[1], 10);
}

function parsePostgresMajorFromServerVersionNum(serverVersionNum) {
  const value = Number.parseInt(String(serverVersionNum).trim(), 10);

  if (!Number.isInteger(value) || value < 10000) {
    throw new Error(`Cannot parse server_version_num value: ${String(serverVersionNum).slice(0, 40)}`);
  }

  return Math.floor(value / 10000);
}

function assertToolMatchesServer({ toolName, toolMajor, serverMajor }) {
  if (toolMajor !== serverMajor) {
    throw new Error(`${toolName} major version mismatch: tool is ${toolMajor}, server is ${serverMajor}. ` +
      'Source server, dump and restore tool majors must match (CI uses postgres:17-alpine).');
  }

  return true;
}

/**
 * Resolves a pg tool to an executable prefix. Priority: explicit --tool-bin,
 * then --docker container exec, then PATH. Returns the resolved major version
 * so callers can enforce server/tool major match.
 */
async function resolveToolCommand({ tool, dockerContainer, toolBin, probe } = {}) {
  if (!tool) {
    throw new Error('resolveToolCommand requires a tool name');
  }

  const runProbe = async (argv) => {
    if (probe) {
      return probe();
    }
    return runCommand([...argv, '--version']);
  };

  let argvPrefix;
  let versionResult;

  if (toolBin) {
    argvPrefix = [toolBin];
    versionResult = await runProbe([toolBin]);
  } else if (dockerContainer) {
    argvPrefix = ['docker', 'exec', dockerContainer];
    versionResult = await runProbe(['docker', 'exec', dockerContainer, tool]);
  } else {
    argvPrefix = [tool];
    versionResult = await runProbe([tool]);
  }

  if (versionResult.code !== 0) {
    const hint = dockerContainer
      ? `docker exec ${dockerContainer} ${tool}`
      : `${tool} on PATH`;

    throw new Error(`${tool} is not available (tried ${hint}). ` +
      `stderr: ${versionResult.stderr.trim().slice(0, 200)}`);
  }

  const major = parsePostgresMajor(versionResult.stdout || versionResult.stderr);

  return {
    bin: toolBin || null,
    dockerContainer: dockerContainer || null,
    major,
    versionOutput: (versionResult.stdout || versionResult.stderr).trim(),
    execPrefix({ tool: toolName }) {
      // With an explicit binary the bin itself is the tool; with docker exec
      // the tool name must be appended after the container prefix.
      return toolBin ? [...argvPrefix] : [...argvPrefix, toolName];
    }
  };
}

function computeFileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function buildBackupManifest({
  url,
  outputDir,
  dumpFile,
  serverVersion,
  serverVersionNum,
  toolVersion,
  snapshotAt,
  snapshotWalLsn,
  durationsMs,
  testGuardBypassed
}) {
  const parts = parseConnectionStringParts(url);
  const dumpPath = path.join(outputDir, dumpFile);

  return {
    kind: 'quickshare-native-consistent-backup',
    contentKind: 'restorable-content-and-configuration',
    createdAt: Date.now(),
    snapshotAt,
    snapshotWalLsn: snapshotWalLsn || null,
    consistency: 'single-transaction-snapshot (pg_dump custom format)',
    host: parts.host,
    port: parts.port,
    database: parts.database,
    serverVersion,
    serverVersionNum,
    toolVersion,
    format: DUMP_FORMAT,
    dumpFile,
    dumpBytes: fs.statSync(dumpPath).size,
    dumpSha256: computeFileSha256(dumpPath),
    durationsMs,
    testGuardBypassed: testGuardBypassed === true
  };
}

function localPoolEnv(connectionString) {
  const parts = parseConnectionStringParts(connectionString);
  return isLocalHost(parts.host) ? { POSTGRES_SSL: 'false' } : {};
}

async function readServerSnapshotState(connectionString) {
  const pool = createPostgresPool(connectionString, {
    env: localPoolEnv(connectionString),
    max: 1
  });

  try {
    const versionNum = await pool.query('SHOW server_version_num');
    const version = await pool.query('SHOW server_version');
    const snapshot = await pool.query('SELECT clock_timestamp() AS ts, pg_current_wal_lsn() AS lsn');
    const row = snapshot.rows[0];

    return {
      serverVersion: version.rows[0].server_version,
      serverVersionNum: Number.parseInt(versionNum.rows[0].server_version_num, 10),
      snapshotAt: new Date(row.ts).getTime(),
      snapshotWalLsn: row.lsn
    };
  } finally {
    await pool.end();
  }
}

function timestampLabel(epochMs) {
  return new Date(epochMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
}

async function createBackup({
  url,
  outputDir,
  dockerContainer,
  toolBin,
  allowNonTest
}) {
  if (!url) {
    throw new Error('A source database URL is required (--url or BACKUP_DATABASE_URL)');
  }

  if (!outputDir) {
    throw new Error('An output directory is required (--output-dir or BACKUP_OUTPUT_DIR)');
  }

  const guard = assertTestDatabaseUrl(url, { allowNonTest });
  const testGuardBypassed = guard === true ? false : guard.testGuardBypassed;

  const snapshotStarted = Date.now();
  const serverState = await readServerSnapshotState(url);
  const snapshotMs = Date.now() - snapshotStarted;
  const serverMajor = parsePostgresMajorFromServerVersionNum(serverState.serverVersionNum);

  const tool = await resolveToolCommand({
    tool: 'pg_dump',
    dockerContainer,
    toolBin
  });
  assertToolMatchesServer({ toolName: 'pg_dump', toolMajor: tool.major, serverMajor });

  fs.mkdirSync(outputDir, { recursive: true });
  const parts = parseConnectionStringParts(url);
  const dumpFile = `quickshare-backup-${timestampLabel(serverState.snapshotAt)}-${parts.database}.dump`;
  const dumpPath = path.join(outputDir, dumpFile);

  const dumpStarted = Date.now();
  if (tool.dockerContainer) {
    const internalDumpPath = '/tmp/issue27-backup.dump';
    const internalUrl = deriveInternalUrl(url);
    const dumpResult = await runCommand([
      ...tool.execPrefix({ tool: 'pg_dump' }),
      '--format=custom', '--no-owner', '--no-privileges',
      '--file', internalDumpPath,
      internalUrl
    ]);

    if (dumpResult.code !== 0) {
      throw new Error(`pg_dump failed inside container: ${dumpResult.stderr.trim().slice(0, 400)}`);
    }

    const copy = await runCommand(['docker', 'cp', `${tool.dockerContainer}:${internalDumpPath}`, dumpPath]);
    if (copy.code !== 0) {
      throw new Error(`docker cp failed: ${copy.stderr.trim().slice(0, 400)}`);
    }

    await runCommand(['docker', 'exec', tool.dockerContainer, 'rm', '-f', internalDumpPath]);
  } else {
    const dumpResult = await runCommand([
      ...tool.execPrefix({ tool: 'pg_dump' }),
      '--format=custom', '--no-owner', '--no-privileges',
      '--file', dumpPath,
      url
    ]);

    if (dumpResult.code !== 0) {
      throw new Error(`pg_dump failed: ${dumpResult.stderr.trim().slice(0, 400)}`);
    }
  }
  const dumpMs = Date.now() - dumpStarted;

  const manifest = buildBackupManifest({
    url,
    outputDir,
    dumpFile,
    serverVersion: serverState.serverVersion,
    serverVersionNum: serverState.serverVersionNum,
    toolVersion: tool.versionOutput,
    snapshotAt: serverState.snapshotAt,
    snapshotWalLsn: serverState.snapshotWalLsn,
    durationsMs: { snapshotMs, dumpMs },
    testGuardBypassed
  });

  const manifestPath = path.join(outputDir, `${dumpFile}.manifest.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { manifest, manifestPath, dumpPath };
}

function deriveInternalUrl(connectionString) {
  const url = new URL(connectionString);
  url.hostname = '127.0.0.1';
  url.port = '5432';
  return url.toString();
}

const BOOLEAN_FLAGS = new Set([
  'allow-non-test',
  'reconciled',
  'no-clean',
  'keep-containers',
  'skip-container-setup'
]);

function camelFlagName(name) {
  return name.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
}

/**
 * Single CLI parsing entry point shared by every backup/restore/verify script.
 * Documented boolean flags take no value and may appear in any position,
 * including end of argv; valued options must be followed by a value.
 * Keys are stored in camelCase (allow-non-test → allowNonTest).
 */
function parseCliArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const name = token.slice(2);

    if (BOOLEAN_FLAGS.has(name)) {
      args[camelFlagName(name)] = true;
      continue;
    }

    if (index + 1 >= argv.length) {
      throw new Error(`Option --${name} requires a value`);
    }

    const value = argv[index + 1];

    if (value.startsWith('--')) {
      throw new Error(`Option --${name} requires a value (got flag ${value})`);
    }

    args[camelFlagName(name)] = value;
    index += 1;
  }

  return args;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const url = args.url || process.env.BACKUP_DATABASE_URL;
  const outputDir = args.outputDir || process.env.BACKUP_OUTPUT_DIR;

  const result = await createBackup({
    url,
    outputDir,
    dockerContainer: args.docker || undefined,
    toolBin: args.toolBin || process.env.PG_DUMP_BIN || undefined,
    allowNonTest: args.allowNonTest === true
  });

  const manifest = result.manifest;
  console.log(`[backup:db] snapshot point: ${new Date(manifest.snapshotAt).toISOString()} wal=${manifest.snapshotWalLsn}`);
  console.log(`[backup:db] server ${manifest.serverVersion}; tool ${manifest.toolVersion}`);
  console.log(`[backup:db] dump ${manifest.dumpFile} (${manifest.dumpBytes} bytes, sha256 ${manifest.dumpSha256})`);
  console.log(`[backup:db] durations: snapshot ${manifest.durationsMs.snapshotMs}ms, dump ${manifest.durationsMs.dumpMs}ms`);
  console.log(`[backup:db] manifest: ${result.manifestPath}`);
  if (manifest.testGuardBypassed) {
    console.log('[backup:db] WARNING: test database guard explicitly bypassed (--allow-non-test)');
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[backup:db] failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertTestDatabaseUrl,
  assertToolMatchesServer,
  buildBackupManifest,
  computeFileSha256,
  createBackup,
  deriveInternalUrl,
  localPoolEnv,
  parseCliArgs,
  parseConnectionStringParts,
  parsePostgresMajor,
  parsePostgresMajorFromServerVersionNum,
  redactUrl,
  redactCommandArgs,
  resolveToolCommand,
  runCommand,
  sanitizeChildEnv
};
