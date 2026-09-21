-- Additive migration: existing Shares keep their IDs, URLs, content, access
-- policy and Favorite state. Every Share starts at content revision 1 with
-- published = TRUE; no unpublish operation exists in this milestone.
ALTER TABLE pages
  ADD COLUMN current_revision BIGINT NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  ADD COLUMN published BOOLEAN NOT NULL DEFAULT TRUE;

-- Immutable content snapshots: body, fixed codeType, title, description and
-- Markdown theme, plus row-level provenance required by parent #24 §3:
--   snapshot_hash  SHA-256 over the canonical fixed content payload;
--   source         the real write path that created this revision
--                  (web | api | clone | dashboard-edit | title-backfill |
--                   baseline-backfill);
--   actor          trusted actor identity where one exists (managed API key
--                   logical id or owner dashboard); never secrets, cookies,
--                   credentials or invented personal identities;
--   restored_from  nullable restore origin; always NULL in this milestone
--                   (no restore entry point exists yet).
-- Baseline backfill stamps the ACTUAL controlled capture moment in
-- created_at; the Share's original creation time stays on pages.created_at.
-- Protection, expiry, Favorite Share and view counts never enter content
-- history. Deleting a Share removes its snapshots.
CREATE TABLE IF NOT EXISTS public.share_revisions (
  share_id TEXT NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL CHECK (revision > 0),
  html_content TEXT NOT NULL,
  code_type TEXT NOT NULL,
  title TEXT,
  description TEXT,
  markdown_theme TEXT,
  created_at BIGINT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  actor TEXT,
  restored_from BIGINT,
  PRIMARY KEY (share_id, revision)
);
