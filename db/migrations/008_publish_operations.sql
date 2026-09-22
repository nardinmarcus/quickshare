-- Idempotent publish operations (#24 §8, issue #32).
--
-- One committed row per (actor_namespace, request_id). There is no running
-- state: the record and its result become visible in the same transaction as
-- the Share, its baseline Revision and the audit entry.
--
-- actor_namespace separates credential identities so the same request_id in
-- another namespace is a legitimate new operation:
--   publish-session:<sid>       browser creators (independently signed session)
--   dashboard-session:<fp>      owner dashboard clone (session fingerprint)
--   managed-key:<logical id>    managed API keys (stable across rotation)
--   legacy-key:<sha256 secret>  legacy environment keys (irreversible
--                               fingerprint; rotation isolates history)
--
-- request_digest is an HMAC over the normalized input (action, target,
-- field presence and values) computed BEFORE any random id, generated
-- password, timestamp or time-derived title exists.
--
-- receipt_encrypted holds the creation receipt (e.g. a generated password)
-- encrypted with the existing application secret capability. It is cleared,
-- together with deleted_at being set, in the same transaction that deletes
-- the resulting Share, leaving a non-content dedupe tombstone: a late replay
-- confirms the operation happened but the result is permanently unavailable.
-- The table has no foreign key to pages on purpose; tombstones outlive the
-- Share lifecycle.
CREATE TABLE IF NOT EXISTS public.publish_operations (
  actor_namespace TEXT NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  target_id TEXT,
  result_share_id TEXT,
  result_revision BIGINT,
  result_access_revision BIGINT,
  receipt_encrypted TEXT,
  created_at BIGINT NOT NULL,
  deleted_at BIGINT,
  PRIMARY KEY (actor_namespace, request_id)
);

CREATE INDEX IF NOT EXISTS publish_operations_result_share_idx
  ON public.publish_operations (result_share_id)
  WHERE result_share_id IS NOT NULL;
