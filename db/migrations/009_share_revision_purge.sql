-- Revision purge tombstones (#34, parent #24 §3/§8/§9).
--
-- A purged snapshot KEEPS its (share_id, revision) identity, original
-- created_at, action provenance (source, actor) and restore origin, but its
-- payload columns and the snapshot hash become NULL. NULL html_content with
-- a non-NULL purged_at is the tombstone marker; live rows always carry real
-- payload bytes (an empty live body is the empty string, never NULL), so
-- both adapters can distinguish live empty content from purged payload
-- robustly. The payload columns therefore relax to nullable; live rows keep
-- their NOT NULL behavior through every write path, and the adapters reject
-- any live projection with a NULL body.
ALTER TABLE public.share_revisions
  ALTER COLUMN html_content DROP NOT NULL,
  ALTER COLUMN snapshot_hash DROP NOT NULL,
  ADD COLUMN purged_at BIGINT;

-- The receipt purge companion (#34): publish_operations rows whose committed
-- result is a purged Share+Revision lose receipt_encrypted. purged_at
-- records when the receipt was scrubbed; deleted_at stays reserved for the
-- whole-Share deletion tombstone (#32) so the two destructive lifecycles
-- remain distinguishable in backups and audits.
ALTER TABLE public.publish_operations
  ADD COLUMN purged_at BIGINT;
