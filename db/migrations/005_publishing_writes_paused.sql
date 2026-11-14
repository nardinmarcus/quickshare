-- T04 (issue #28): the site settings gain the publishing write maintenance
-- switch. `publishing_writes_paused` defaults to false and is only ever set
-- through the controlled operator path (see docs/maintenance.md); it is not
-- a per-user setting. While true, publishing writes are refused with a
-- maintenance 503 and view events are not counted.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'site_settings'
      AND column_name = 'publishing_writes_paused'
      AND data_type <> 'boolean'
  ) THEN
    RAISE EXCEPTION 'Incompatible QuickShare schema: public.site_settings.publishing_writes_paused expected boolean';
  END IF;
END
$$;

ALTER TABLE public.site_settings
  ADD COLUMN IF NOT EXISTS publishing_writes_paused BOOLEAN NOT NULL DEFAULT FALSE;
