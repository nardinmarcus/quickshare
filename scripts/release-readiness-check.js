#!/usr/bin/env node
'use strict';

const { execFileSync, spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const INTEGRATION_TEST = path.join(ROOT, 'test/integration/postgres-release-readiness.test.js');
const CLIENT_COMMIT = '2eec5060c1f7e10e7849fe6085f673d5db72e038';
const RELEASE_TEST_COUNT = 3;
const CANONICAL_POSTGRES_TEST_DATABASE = 'issue39_api_publish_test';
const INVALID_URL = 'POSTGRES_TEST_URL must be a localhost PostgreSQL URL for a _test database using only sslmode options';
const INVALID_CANONICAL_DATABASE = `POSTGRES_TEST_URL must target the canonical PostgreSQL suite database ${CANONICAL_POSTGRES_TEST_DATABASE}`;
const ALLOWED_SSL_MODES = new Set(['disable', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify']);

function normalizeHost(host) {
  return String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
}

function isLoopbackHost(host) {
  return ['localhost', '127.0.0.1', '::1'].includes(normalizeHost(host));
}

function validatePostgresTestUrl(raw) {
  let parsed;
  try { parsed = new URL(raw || ''); }
  catch { throw new Error(INVALID_URL); }

  let database;
  try { database = decodeURIComponent(parsed.pathname.slice(1)); }
  catch { throw new Error(INVALID_URL); }

  const queryKeys = [...parsed.searchParams.keys()];
  const sslModes = parsed.searchParams.getAll('sslmode');
  if (queryKeys.some(key => key !== 'sslmode')
    || sslModes.length > 1
    || (sslModes.length === 1 && !ALLOWED_SSL_MODES.has(sslModes[0]))) {
    throw new Error(INVALID_URL);
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !isLoopbackHost(parsed.hostname)
    || !database.endsWith('_test')) {
    throw new Error(INVALID_URL);
  }

  let effective;
  try {
    // Parse exactly as node-postgres will, without opening a socket.
    effective = new Client({ connectionString: parsed.href }).connectionParameters;
  } catch {
    throw new Error(INVALID_URL);
  }

  const authorityHost = normalizeHost(parsed.hostname);
  const effectiveHost = normalizeHost(effective.host);
  const authorityPort = parsed.port ? Number(parsed.port) : 5432;
  const effectivePort = Number(effective.port);
  const effectiveDatabase = String(effective.database || '');
  if (!isLoopbackHost(effectiveHost)
    || effectiveHost !== authorityHost
    || !Number.isInteger(authorityPort) || authorityPort < 1 || authorityPort > 65535
    || effectivePort !== authorityPort
    || effectiveDatabase !== database
    || !effectiveDatabase.endsWith('_test')) {
    throw new Error(INVALID_URL);
  }

  return parsed;
}

function validateCanonicalPostgresSuiteUrl(raw) {
  const parsed = validatePostgresTestUrl(raw);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (database !== CANONICAL_POSTGRES_TEST_DATABASE) {
    throw new Error(INVALID_CANONICAL_DATABASE);
  }
  return parsed;
}

function validateTapSummary(output, expectedTests = RELEASE_TEST_COUNT) {
  const plans = [...String(output).matchAll(/^1\.\.(\d+)\s*$/gm)];
  const count = (label) => {
    const matches = [...String(output).matchAll(new RegExp(`^# ${label} (\\d+)\\s*$`, 'gm'))];
    return matches.length === 1 ? Number(matches[0][1]) : null;
  };

  return plans.length === 1
    && Number(plans[0][1]) === expectedTests
    && count('tests') === expectedTests
    && count('pass') === expectedTests
    && count('fail') === 0
    && count('cancelled') === 0
    && count('skipped') === 0
    && count('todo') === 0;
}

function validateClientCandidate(root) {
  if (!root) throw new Error('QUICKSHARE_TEST_CLIENT_ROOT must name the pinned, read-only client checkout');
  let commit;
  let status;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    status = execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    throw new Error('Could not verify the pinned QuickShare client checkout');
  }
  if (commit !== CLIENT_COMMIT) throw new Error('QuickShare client checkout does not match the pinned #43 candidate');
  if (status) throw new Error('Pinned QuickShare client checkout must be clean and read-only');
  return commit;
}

function integrationEnvironment() {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || os.homedir(),
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    NODE_ENV: 'test',
    POSTGRES_TEST_URL: process.env.POSTGRES_TEST_URL,
    QUICKSHARE_TEST_CLIENT_ROOT: process.env.QUICKSHARE_TEST_CLIENT_ROOT,
    QUICKSHARE_REQUIRE_CLIENT_TESTS: '1'
  };
}

async function runReleaseTests() {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', INTEGRATION_TEST], {
      cwd: ROOT, env: integrationEnvironment(), stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.setEncoding('utf8').on('data', chunk => process.stderr.write(chunk));
    child.once('error', error => {
      console.error(`Could not start lifecycle verifier: ${error.message}`);
      resolve(1);
    });
    child.once('close', status => {
      if (status !== 0) return resolve(status === null ? 1 : status);
      if (!validateTapSummary(stdout, RELEASE_TEST_COUNT)) {
        console.error(`Release verifier must report exactly ${RELEASE_TEST_COUNT} passes with zero failures, cancellations, skips, or TODOs`);
        return resolve(1);
      }
      resolve(0);
    });
  });
}

async function main() {
  try {
    validateCanonicalPostgresSuiteUrl(process.env.POSTGRES_TEST_URL);
    validateClientCandidate(process.env.QUICKSHARE_TEST_CLIENT_ROOT);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }

  process.exitCode = await runReleaseTests();
}

if (require.main === module) main().catch(error => {
  console.error(`Lifecycle verifier failed: ${error.message}`);
  process.exitCode = 1;
});

module.exports = {
  validateCanonicalPostgresSuiteUrl,
  validateClientCandidate,
  validatePostgresTestUrl,
  validateTapSummary
};
