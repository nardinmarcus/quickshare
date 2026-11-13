#!/usr/bin/env node
require('dotenv').config();

const { createPostgresPool } = require('../models/postgres-config');
const { withPublishingWrite } = require('../models/publishing');
const { derivePageTitle } = require('../utils/pageTitle');
const {
  computeSnapshotHash,
  toContentRevisionString
} = require('../utils/contentRevision');

function parseArgs(argv) {
  const options = {
    write: false,
    limit: 200
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === '--write') {
      options.write = true;
    } else if (value === '--limit') {
      options.limit = Number.parseInt(argv[index + 1], 10);
      index += 1;
    }
  }

  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error('--limit must be a positive integer');
  }

  return options;
}

// A title is content (T06): a --write title change is a content update
// and must produce a Revision like any other, never a bare UPDATE that
// bypasses the snapshot history. When the revision schema (migration
// 007) is present, each changed title advances current_revision and
// writes its snapshot inside the caller's gated transaction, first
// establishing the Revision 1 baseline for a pre-protocol Share. On a
// pre-007 database the legacy plain UPDATE remains the only option.
async function applyTitleUpdate(client, page, nextTitle, hasRevisions) {
  if (!hasRevisions) {
    await client.query('UPDATE pages SET title = $1 WHERE id = $2', [nextTitle, page.id]);
    return;
  }

  const lockResult = await client.query(
    'SELECT * FROM pages WHERE id = $1 FOR UPDATE',
    [page.id]
  );
  const row = lockResult.rows[0];

  if (!row) {
    return;
  }

  const fields = {
    htmlContent: row.html_content,
    codeType: row.code_type || 'html',
    title: row.title ?? null,
    description: row.description ?? null,
    markdownTheme: row.markdown_theme ?? null
  };
  let revision = toContentRevisionString(row.current_revision);
  const capturedAt = Date.now();

  if (revision === null) {
    await client.query(
      `
        INSERT INTO share_revisions (
          share_id, revision, html_content, code_type, title, description,
          markdown_theme, snapshot_hash, source, actor_type, actor_id,
          restored_from_revision, created_at
        )
        VALUES ($1, 1, $2, $3, $4, $5, $6, $7, 'baseline', 'operator', NULL, NULL, $8)
      `,
      [
        row.id,
        fields.htmlContent,
        fields.codeType,
        fields.title,
        fields.description,
        fields.markdownTheme,
        computeSnapshotHash(row.id, '1', fields),
        capturedAt
      ]
    );
    await client.query('UPDATE pages SET current_revision = 1 WHERE id = $1', [row.id]);
    revision = '1';
  }

  const nextRevision = (BigInt(revision) + 1n).toString();
  const nextFields = { ...fields, title: nextTitle };

  await client.query(
    'UPDATE pages SET title = $1, current_revision = $2::bigint WHERE id = $3',
    [nextTitle, nextRevision, row.id]
  );
  await client.query(
    `
      INSERT INTO share_revisions (
        share_id, revision, html_content, code_type, title, description,
        markdown_theme, snapshot_hash, source, actor_type, actor_id,
        restored_from_revision, created_at
      )
      VALUES ($1, $2::bigint, $3, $4, $5, $6, $7, $8, 'title-backfill', 'operator', NULL, NULL, $9)
    `,
    [
      row.id,
      nextRevision,
      nextFields.htmlContent,
      nextFields.codeType,
      nextFields.title,
      nextFields.description,
      nextFields.markdownTheme,
      computeSnapshotHash(row.id, nextRevision, nextFields),
      capturedAt
    ]
  );
}

async function runBackfill(queryable, options) {
  let hasRevisions = false;

  if (options.write) {
    const tableResult = await queryable.query(
      "SELECT to_regclass('public.share_revisions') AS revisions_table"
    );
    hasRevisions = Boolean(tableResult.rows[0]?.revisions_table);
  }

  const result = await queryable.query(
    `
      SELECT id, html_content, code_type, title, created_at
      FROM pages
      WHERE title IS NULL OR title = '' OR title = id
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [options.limit]
  );

  let changed = 0;

  for (const page of result.rows) {
    const nextTitle = derivePageTitle(
      page.html_content,
      page.code_type || 'html',
      null,
      Number(page.created_at) || Date.now()
    );

    if (!nextTitle || nextTitle === page.title) {
      continue;
    }

    changed += 1;
    console.log(`${options.write ? 'update' : 'dry-run'} ${page.id}: ${nextTitle}`);

    if (options.write) {
      await applyTitleUpdate(queryable, page, nextTitle, hasRevisions);
    }
  }

  console.log(`${options.write ? 'updated' : 'would update'} ${changed} of ${result.rows.length} scanned pages`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL or POSTGRES_URL is required');
  }

  const pool = createPostgresPool(connectionString, { max: 1 });

  try {
    if (options.write) {
      // --write is a real publishing write entrypoint: it goes through the
      // maintenance gate (T04), so a paused instance refuses the backfill
      // instead of bypassing the gate with direct UPDATEs. The dry-run
      // stays a plain read and remains available during maintenance.
      await withPublishingWrite(pool, client => runBackfill(client, options));
    } else {
      await runBackfill(pool, options);
    }
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
