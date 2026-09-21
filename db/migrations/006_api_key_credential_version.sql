ALTER TABLE api_keys
  ADD COLUMN credential_version BIGINT NOT NULL DEFAULT 1
  CHECK (credential_version > 0);
