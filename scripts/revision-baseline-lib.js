'use strict';

// Baseline backfill for Share content Revisions (T06, issue #30; parent
// spec issue #24 §11 steps 3–4).
//
// The rollout order is fixed and this module implements exactly one step
// of it:
//   1. the backward-compatible expansion migration (007) has run;
//   2. a gate-aware application is deployed;
//   3. the operator enters write maintenance and the pause drains every
//      in-flight publishing transaction;
//   4. THIS backfill runs, inside that window;
//   5. only then is the new write protocol deployed and writing resumed.
//
// Because the pause toggle takes the maintenance gate exclusively, a
// committed `publishing_writes_paused = true` is proof that no earlier
// write transaction can still commit. This backfill therefore REQUIRES
// the flag to already be set — it never pauses or resumes the instance
// itself, and a missing flag is never treated as permission to proceed.
// It additionally takes the gate exclusively for its own transaction, so
// no publishing write can interleave with the baseline pass.
//
// The DML itself is minimal and idempotent: every Share whose
// current_revision is still NULL gains a Revision 1 snapshot capturing
// its current materialized fields byte-for-byte (original ID, URL, body
// and state preserved), stamped with the capture time of THIS run — not
// the Share's original creation time. Shares that already have a
// baseline are skipped, so a second run reports baselined: 0.

const { MAINTENANCE_GATE_LOCK_KEY } = require('../utils/publishing');
const {
  computeSnapshotHash,
  toContentRevisionString
} = require('../utils/contentRevision');

async function runBaselineBackfill(pool, { now = Date.now() } = {}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    try {
      // The exclusive gate wait is a drain barrier; it must not be cut
      // short by a statement timeout.
      await client.query('SET LOCAL statement_timeout = 0');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [MAINTENANCE_GATE_LOCK_KEY]
      );

      const tableResult = await client.query(
        "SELECT to_regclass('public.share_revisions') AS revisions_table"
      );

      if (!tableResult.rows[0]?.revisions_table) {
        throw new Error(
          'public.share_revisions does not exist. Run the expansion migration first: npm run db:migrate'
        );
      }

      const settingsResult = await client.query(
        'SELECT publishing_writes_paused FROM public.site_settings WHERE id = 1 LIMIT 1'
      );
      const paused = settingsResult.rows[0]?.publishing_writes_paused;

      if (typeof paused !== 'boolean') {
        throw new Error(
          'Publishing maintenance setting is unavailable. Run the migrations first: npm run db:migrate'
        );
      }

      if (!paused) {
        throw new Error(
          'Refusing to backfill Revision baselines while publishing writes are not paused. '
          + 'Enter write maintenance first (npm run db:maintenance -- pause) and let in-flight '
          + 'writes drain; the backfill never pauses or resumes the instance itself.'
        );
      }

      const pendingResult = await client.query(
        'SELECT * FROM public.pages WHERE current_revision IS NULL ORDER BY id FOR UPDATE'
      );
      let baselined = 0;

      for (const row of pendingResult.rows) {
        const fields = {
          htmlContent: row.html_content,
          codeType: row.code_type || 'html',
          title: row.title ?? null,
          description: row.description ?? null,
          markdownTheme: row.markdown_theme ?? null
        };

        await client.query(
          `
            INSERT INTO public.share_revisions (
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
            now
          ]
        );
        await client.query(
          'UPDATE public.pages SET current_revision = 1 WHERE id = $1',
          [row.id]
        );
        baselined += 1;
      }

      // Consistency guard: after the pass, every Share with a current
      // pointer must have the snapshot that pointer names. Anything else
      // means the history was damaged outside this protocol; fail loudly
      // instead of fabricating provenance.
      const orphanResult = await client.query(`
        SELECT p.id
        FROM public.pages p
        WHERE p.current_revision IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.share_revisions r
            WHERE r.share_id = p.id AND r.revision = p.current_revision
          )
        ORDER BY p.id
        LIMIT 5
      `);

      if (orphanResult.rows.length > 0) {
        throw new Error(
          'Shares with a current_revision but no matching snapshot: '
          + orphanResult.rows.map(row => row.id).join(', ')
        );
      }

      const countResult = await client.query(
        'SELECT COUNT(*)::int AS count FROM public.pages WHERE current_revision IS NOT NULL'
      );

      await client.query('COMMIT');

      return {
        baselined,
        skipped: countResult.rows[0].count - baselined,
        capturedAt: now
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

// Read-only probe used by tests and operators: how many Shares still
// lack a baseline. Never writes.
async function countSharesWithoutBaseline(pool) {
  const result = await pool.query(
    'SELECT COUNT(*)::int AS count FROM public.pages WHERE current_revision IS NULL'
  );
  return result.rows[0].count;
}

module.exports = {
  countSharesWithoutBaseline,
  runBaselineBackfill,
  toContentRevisionString
};
