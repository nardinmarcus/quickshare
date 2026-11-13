-- T01 (issue #25): every Share gains an access_revision that starts at 1 and
-- is advanced whenever its access policy changes, revoking access cookies
-- issued under earlier revisions. BIGINT in the database, decimal string in
-- JSON. Existing rows backfill to the initial revision 1.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pages'
      AND column_name = 'access_revision'
      AND data_type <> 'bigint'
  ) THEN
    RAISE EXCEPTION 'Incompatible QuickShare schema: public.pages.access_revision expected bigint';
  END IF;
END
$$;

ALTER TABLE public.pages
  ADD COLUMN IF NOT EXISTS access_revision BIGINT NOT NULL DEFAULT 1;

UPDATE public.pages
SET access_revision = 1
WHERE access_revision IS NULL OR access_revision < 1;
