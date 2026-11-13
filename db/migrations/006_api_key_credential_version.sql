-- T05 (issue #29): every managed API Key gains a `credential_version` that
-- starts at 1 and is advanced atomically whenever the Key is rotated. A
-- request records the credential version it first verified; its write
-- transaction locks the Key row and re-checks the version, so a request
-- that verified the old secret can no longer write once a rotation (or a
-- delete) has committed. BIGINT in the database, decimal string in JSON.
-- Existing rows backfill to the initial version 1.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'api_keys'
      AND column_name = 'credential_version'
      AND data_type <> 'bigint'
  ) THEN
    RAISE EXCEPTION 'Incompatible QuickShare schema: public.api_keys.credential_version expected bigint';
  END IF;
END
$$;

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS credential_version BIGINT NOT NULL DEFAULT 1;

UPDATE public.api_keys
SET credential_version = 1
WHERE credential_version IS NULL OR credential_version < 1;
