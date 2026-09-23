-- Key scopes and per-Share read grants (#36, parent #24 §6).
--
-- Scopes are the global operation vocabulary of a managed Key:
--   share:create | share:read | share:update | share:publish.
-- This milestone writes only share:create and share:read; the other two
-- exist so later tickets (#37/#39) never need a second column migration.
-- Existing managed keys keep working exactly as before: every row migrates
-- to create-only. Legacy environment keys are not rows here and stay
-- create-only by definition. The auto-grant flag defaults to FALSE: owning
-- a Key never widens its reach on its own, and enabling it later is an
-- explicit owner decision bound to read+update scopes.
ALTER TABLE public.api_keys
  ADD COLUMN scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN auto_grant_new_share_edit BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE public.api_keys SET scopes = '["share:create"]'::jsonb;

-- A grant binds ONE logical Key to ONE Share. The foreign keys reference
-- identity, not secrets: rotation replaces the hash and bumps
-- credential_version while keeping the row, so every grant silently
-- survives rotation; deleting the Key or the Share removes its grants.
-- Grants never cascade into content — revisions and the materialized
-- projection carry no grant state.
--
-- can_read / can_update / can_publish mirror the parent §6 resource
-- permissions in one row per (api_key_id, share_id). Only can_read is ever
-- written by this milestone, but the update-requires-read invariant is
-- committed now so a later ticket cannot create an unwritable grant.
CREATE TABLE IF NOT EXISTS public.share_grants (
  api_key_id TEXT NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
  share_id TEXT NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
  can_read BOOLEAN NOT NULL DEFAULT FALSE,
  can_update BOOLEAN NOT NULL DEFAULT FALSE,
  can_publish BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (api_key_id, share_id),
  CHECK (NOT can_update OR can_read),
  CHECK (can_read OR can_update OR can_publish)
);

CREATE INDEX IF NOT EXISTS share_grants_share_id_idx
  ON public.share_grants (share_id);
