-- T06 (issue #30): every Share gains a content Revision history. This is
-- the backward-compatible EXPANSION step of the parent spec's baseline
-- rollout (issue #24 §11): it only adds nullable/new structures, so the
-- previous application keeps working unchanged. The baseline DML that
-- fills Revision 1 for pre-existing Shares is deliberately NOT part of
-- this migration: it runs separately, inside a controlled
-- write-maintenance window, via `npm run db:backfill-revisions`, after
-- the operator has paused and drained publishing writes.
--
-- `current_revision` stays NULL for a Share that has no baseline yet;
-- application code treats NULL as "not baselined" and never substitutes
-- a revision silently. `published` starts true for every Share; no
-- publish/unpublish operation exists yet, so the flag only records the
-- current state. Revisions are BIGINT in the database and decimal
-- strings in JSON.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pages'
      AND column_name = 'current_revision'
      AND data_type <> 'bigint'
  ) THEN
    RAISE EXCEPTION 'Incompatible QuickShare schema: public.pages.current_revision expected bigint';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pages'
      AND column_name = 'published'
      AND data_type <> 'boolean'
  ) THEN
    RAISE EXCEPTION 'Incompatible QuickShare schema: public.pages.published expected boolean';
  END IF;
END
$$;

ALTER TABLE public.pages
  ADD COLUMN IF NOT EXISTS current_revision BIGINT;

ALTER TABLE public.pages
  ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT TRUE;

-- Immutable content snapshots. One row per (share, revision): the exact
-- body bytes, the fixed codeType, title, description and Markdown Theme
-- Preset, an integrity hash over Share + revision + payload, the
-- operation identity/source that produced the snapshot, and a nullable
-- restore source (set only by a future restore operation; restoring is
-- not part of T06). Protection, expiry, favorites and view counts are
-- access/runtime state and are never written into content history.
CREATE TABLE IF NOT EXISTS public.share_revisions (
  share_id TEXT NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL,
  html_content TEXT NOT NULL,
  code_type TEXT NOT NULL,
  title TEXT,
  description TEXT,
  markdown_theme TEXT,
  snapshot_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  restored_from_revision BIGINT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (share_id, revision)
);
