-- T10 (issue #34): the owner can permanently purge one non-current
-- Revision's payload from the admin, leaving a non-content tombstone.
-- Until now a snapshot row could not represent that state: html_content
-- and snapshot_hash were NOT NULL, so a cleared payload had nowhere to
-- live (T09 could only exercise the purged-restore refusal on the
-- memory Adapter). This migration is the expansion step that makes the
-- tombstone representable:
--
-- - html_content and snapshot_hash become nullable. A purged row sets
--   both to NULL together with title, description and markdown_theme:
--   the stored hash is derived from the payload, so keeping it would
--   leave a content-verification oracle for exactly the bytes the
--   owner asked to remove.
-- - purged_at records when the payload was cleared (NULL while the
--   snapshot is intact). The tombstone keeps only the Share ID, the
--   revision number, the fixed code type, the capture time, the
--   operation identity/source, the restore provenance and purged_at —
--   never any content, title, description, theme or recoverable
--   ciphertext — and a tombstone can never be restored from.
--
-- Existing rows are untouched: every snapshot written so far simply
-- has purged_at NULL and keeps its payload and hash.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'share_revisions'
      AND column_name = 'purged_at'
      AND data_type <> 'bigint'
  ) THEN
    RAISE EXCEPTION 'Incompatible QuickShare schema: public.share_revisions.purged_at expected bigint';
  END IF;
END
$$;

ALTER TABLE public.share_revisions
  ALTER COLUMN html_content DROP NOT NULL;

ALTER TABLE public.share_revisions
  ALTER COLUMN snapshot_hash DROP NOT NULL;

ALTER TABLE public.share_revisions
  ADD COLUMN IF NOT EXISTS purged_at BIGINT;
