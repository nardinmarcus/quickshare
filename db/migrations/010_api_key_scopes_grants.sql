-- T12 (issue #36): managed Keys gain scopes and per-Share resource
-- grants, so the owner can authorize one named Key to read specific
-- Shares back through the v1 API without handing it the whole instance
-- (parent spec #24 §3/§6).
--
-- - `api_keys.scopes` is a JSON array of scope strings drawn from
--   share:create / share:read / share:update / share:publish. Existing
--   managed Keys migrate to create-only (["share:create"]): upgrading
--   never widens a credential that already exists. The legacy
--   environment-variable Key has no row and stays create-only by
--   construction; it can never hold a management scope or a grant.
-- - `api_keys.auto_grant_new_share_edit` records the owner's opt-in for
--   automatically granting a Key edit access to Shares it creates in
--   the future (parent spec #24 §6). It defaults to FALSE for every
--   existing and new Key and only takes effect with the update
--   capability that consumes it; this migration introduces the stored
--   attribute at its spec default, nothing more.
-- - `share_grants` holds at most one row per (api_key_id, share_id):
--   the resource permissions that Key holds on that Share. A Share
--   never "belongs" to a Key — the grant is the whole relationship.
--   can_update implies can_read (enforced by the repository on every
--   write); can_publish does NOT imply can_read, so a publish-only
--   grant exposes only the restricted state fields. Rotation keeps the
--   logical Key ID, so grants survive rotation untouched; deleting a
--   Key or a Share removes its grant rows in the same transaction as
--   the delete (the repository does this explicitly).
--
-- The table deliberately has NO foreign keys, mirroring migration
-- 008: grant cleanup is an explicit transactional step of the Key /
-- Share delete operations, and a grant row must never silently
-- outlive or resurrect a deleted resource through cascade timing.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'api_keys'
      AND column_name = 'scopes'
      AND data_type <> 'text'
  ) THEN
    RAISE EXCEPTION 'Incompatible QuickShare schema: public.api_keys.scopes expected text';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'api_keys'
      AND column_name = 'auto_grant_new_share_edit'
      AND data_type <> 'boolean'
  ) THEN
    RAISE EXCEPTION 'Incompatible QuickShare schema: public.api_keys.auto_grant_new_share_edit expected boolean';
  END IF;
END
$$;

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS scopes TEXT NOT NULL DEFAULT '["share:create"]';

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS auto_grant_new_share_edit BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing rows take the column default above on supporting servers;
-- normalize any straggler explicitly so every pre-T12 Key is exactly
-- create-only after this migration.
UPDATE public.api_keys
SET scopes = '["share:create"]'
WHERE scopes IS NULL OR btrim(scopes) = '';

CREATE TABLE IF NOT EXISTS public.share_grants (
  api_key_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  can_read BOOLEAN NOT NULL DEFAULT FALSE,
  can_update BOOLEAN NOT NULL DEFAULT FALSE,
  can_publish BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (api_key_id, share_id)
);

CREATE INDEX IF NOT EXISTS idx_share_grants_share_id
  ON public.share_grants (share_id);
