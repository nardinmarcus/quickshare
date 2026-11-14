-- T08 (issue #32): publish operation records make Share creation safely
-- retryable after a lost response (parent spec #24 §8). One row per
-- committed create/clone operation, keyed by the caller's credential
-- namespace and the client-supplied request identifier:
--
-- - the row is written in the SAME transaction as the Share, its
--   Revision 1 snapshot and the create audit, so a committed operation
--   and its result become visible atomically — there is no persisted
--   "running" state a crashed process could leave behind;
-- - the normalized request HMAC binds the identifier to one exact input:
--   the same identifier with a different input is a conflict (409),
--   never a second Share and never a silent replay of the wrong result;
-- - the receipt carries only the fields the original response returned
--   (never the content body); the sensitive part (a server-generated
--   password) is stored encrypted with the existing secret-v1 scheme;
-- - when the resulting Share is fully deleted, the row is kept as a
--   content-free dedup tombstone (receipt cleared, result_state =
--   'result_unavailable') so a late retry can neither resurrect the
--   Share nor mint a replacement under the old identifier.
--
-- The table deliberately has NO foreign key to pages: the tombstone must
-- survive the deletion of the Share it points at. Result revisions are
-- BIGINT like every other version column and travel as decimal strings
-- in JSON.
CREATE TABLE IF NOT EXISTS public.publish_operations (
  actor_namespace TEXT NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  request_hmac TEXT NOT NULL,
  result_share_id TEXT,
  result_revision BIGINT,
  result_access_revision BIGINT,
  receipt_encrypted TEXT,
  result_state TEXT NOT NULL DEFAULT 'committed',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (actor_namespace, request_id)
);

CREATE INDEX IF NOT EXISTS idx_publish_operations_result_share
  ON public.publish_operations (result_share_id);
