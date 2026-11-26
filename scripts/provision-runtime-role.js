#!/usr/bin/env node
require('dotenv').config();

const { createPostgresPool } = require('../models/postgres-config');

const ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const LEDGER = 'quickshare_schema_migrations';

function parseArgs(argv) {
  const options = { role: 'quickshare_app', verifyOnly: false };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--role') {
      options.role = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--verify') {
      options.verifyOnly = true;
    } else {
      throw new Error(`Unknown option: ${argv[index]}`);
    }
  }

  if (!ROLE_PATTERN.test(options.role || '')) {
    throw new Error('--role must be a lowercase PostgreSQL identifier');
  }

  return options;
}

async function provision(client, role, password) {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  const literal = (await client.query('SELECT quote_literal($1) AS value', [password])).rows[0].value;

  if (exists.rowCount === 0) {
    await client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${literal}`);
  } else {
    await client.query(`ALTER ROLE ${role} PASSWORD ${literal}`);
  }

  const { database } = (await client.query('SELECT quote_ident(current_database()) AS database')).rows[0];
  await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await client.query(`REVOKE INSERT, UPDATE, DELETE ON public.${LEDGER} FROM ${role}`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);
}

async function verify(client, role) {
  const tables = await client.query(
    `
      SELECT c.relname AS name,
             has_table_privilege($1, c.oid, 'SELECT') AS can_select,
             has_table_privilege($1, c.oid, 'INSERT') AS can_insert,
             has_table_privilege($1, c.oid, 'UPDATE') AS can_update,
             has_table_privilege($1, c.oid, 'DELETE') AS can_delete,
             has_table_privilege($1, c.oid, 'TRUNCATE') AS can_truncate,
             pg_has_role($1, c.relowner, 'MEMBER') AS owns
      FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
      ORDER BY c.relname
    `,
    [role]
  );
  const attrs = (await client.query(
    'SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit FROM pg_roles WHERE rolname = $1',
    [role]
  )).rows[0];
  const failures = [];

  if (!attrs) {
    failures.push(`role ${role} does not exist`);
  } else if (attrs.rolsuper || attrs.rolcreatedb || attrs.rolcreaterole || attrs.rolinherit) {
    failures.push(`role ${role} has elevated attributes`);
  }

  for (const table of tables.rows) {
    const ledger = table.name === LEDGER;
    const expectWrite = !ledger;
    const ok = table.can_select
      && table.can_insert === expectWrite
      && table.can_update === expectWrite
      && table.can_delete === expectWrite
      && !table.can_truncate
      && !table.owns;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${table.name}: select=${table.can_select} insert=${table.can_insert} update=${table.can_update} delete=${table.can_delete} truncate=${table.can_truncate} owner=${table.owns}`);
    if (!ok) failures.push(table.name);
  }

  const schemaCreate = (await client.query("SELECT has_schema_privilege($1, 'public', 'CREATE') AS value", [role])).rows[0].value;
  console.log(`${schemaCreate ? 'FAIL' : 'PASS'} schema public CREATE=${schemaCreate}`);
  if (schemaCreate) failures.push('schema CREATE');

  return failures;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_MIGRATION_URL
    || process.env.DATABASE_URL_UNPOOLED
    || process.env.POSTGRES_URL_NON_POOLING;

  if (!connectionString) {
    throw new Error('Run as the schema owner: set DATABASE_MIGRATION_URL to the direct owner URL');
  }

  const pool = createPostgresPool(connectionString, { max: 1 });
  const client = await pool.connect();

  try {
    if (!options.verifyOnly) {
      const password = process.env.RUNTIME_ROLE_PASSWORD || '';

      if (password.length < 32) {
        throw new Error('RUNTIME_ROLE_PASSWORD must be set to a random value of at least 32 characters');
      }

      await client.query('BEGIN');
      await provision(client, options.role, password);
      await client.query('COMMIT');
      console.log(`[provision-runtime-role] ${options.role} provisioned`);
    }

    const failures = await verify(client, options.role);

    if (failures.length > 0) {
      throw new Error(`${failures.length} privilege check(s) failed`);
    }

    console.log('[provision-runtime-role] all privilege checks passed');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[provision-runtime-role] failed: ${error.message}`);
  process.exitCode = 1;
});
