const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIGRATION_FILENAME = /^(\d{3})_([a-z0-9_-]+)\.sql$/;

function loadMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  const sqlFiles = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.sql'))
    .map(entry => entry.name)
    .sort();
  const seenVersions = new Set();

  return sqlFiles.map((name) => {
    const match = name.match(MIGRATION_FILENAME);

    if (!match) {
      throw new Error(`Invalid migration filename: ${name}`);
    }

    const version = match[1];

    if (seenVersions.has(version)) {
      throw new Error(`Duplicate migration version: ${version}`);
    }

    seenVersions.add(version);
    const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');

    return {
      version,
      name,
      sql,
      checksum: crypto.createHash('sha256').update(sql).digest('hex')
    };
  });
}

async function runMigrations(pool, options = {}) {
  const migrations = loadMigrations(options.migrationsDir || DEFAULT_MIGRATIONS_DIR);
  const logger = options.logger || console;
  const client = await pool.connect();
  let inTransaction = false;

  try {
    await client.query('BEGIN');
    inTransaction = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtext('quickshare:migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.quickshare_schema_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at BIGINT NOT NULL
      )
    `);

    const result = await client.query(
      'SELECT version, name, checksum FROM public.quickshare_schema_migrations ORDER BY version ASC'
    );
    const localByVersion = new Map(migrations.map(migration => [migration.version, migration]));
    const appliedByVersion = new Map(result.rows.map(row => [row.version, row]));

    for (const row of result.rows) {
      const local = localByVersion.get(row.version);

      if (!local) {
        throw new Error(`Unknown applied migration: ${row.version}`);
      }

      if (local.checksum !== row.checksum) {
        throw new Error(`Migration checksum mismatch: ${local.name}`);
      }
    }

    const summary = { applied: [], skipped: [] };
    const appliedNames = [];

    for (const migration of migrations) {
      if (appliedByVersion.has(migration.version)) {
        summary.skipped.push(migration.version);
        continue;
      }

      await client.query(migration.sql.trim());
      await client.query(
        `
          INSERT INTO public.quickshare_schema_migrations (version, name, checksum, applied_at)
          VALUES ($1, $2, $3, $4)
        `,
        [migration.version, migration.name, migration.checksum, Date.now()]
      );
      summary.applied.push(migration.version);
      appliedNames.push(migration.name);
    }

    await client.query('COMMIT');
    inTransaction = false;

    for (const name of appliedNames) {
      logger.info(`[db:migrate] applied ${name}`);
    }

    return summary;
  } catch (error) {
    if (inTransaction) {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  DEFAULT_MIGRATIONS_DIR,
  loadMigrations,
  runMigrations
};
