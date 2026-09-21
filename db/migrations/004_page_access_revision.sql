-- Additive migration: old Shares retain their IDs, content and protection.
-- Deploy only with a writer cutover; pre-revision applications are not safe rollback targets.
ALTER TABLE pages
  ADD COLUMN access_revision BIGINT NOT NULL DEFAULT 1
  CHECK (access_revision > 0);
