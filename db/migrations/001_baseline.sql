DO $$
DECLARE
  schema_errors TEXT;
  existing_table_name TEXT;
  existing_table REGCLASS;
  id_attribute SMALLINT;
BEGIN
  WITH expected_columns (table_name, column_name, data_type, is_required) AS (
    VALUES
      ('pages', 'id', 'text', TRUE),
      ('pages', 'html_content', 'text', TRUE),
      ('pages', 'created_at', 'bigint', TRUE),
      ('pages', 'password_hash', 'text', FALSE),
      ('pages', 'encrypted_password', 'text', FALSE),
      ('pages', 'is_protected', 'integer', FALSE),
      ('pages', 'code_type', 'text', FALSE),
      ('pages', 'title', 'text', FALSE),
      ('pages', 'description', 'text', FALSE),
      ('pages', 'expires_at', 'bigint', FALSE),
      ('pages', 'markdown_theme', 'text', FALSE),
      ('pages', 'view_count', 'bigint', FALSE),
      ('audit_logs', 'id', 'integer', TRUE),
      ('audit_logs', 'action', 'text', TRUE),
      ('audit_logs', 'page_id', 'text', TRUE),
      ('audit_logs', 'details', 'text', TRUE),
      ('audit_logs', 'ip', 'text', TRUE),
      ('audit_logs', 'created_at', 'bigint', TRUE),
      ('api_keys', 'id', 'text', TRUE),
      ('api_keys', 'name', 'text', TRUE),
      ('api_keys', 'key_hash', 'text', TRUE),
      ('api_keys', 'key_prefix', 'text', TRUE),
      ('api_keys', 'created_at', 'bigint', TRUE),
      ('api_keys', 'last_used_at', 'bigint', TRUE)
  )
  SELECT string_agg(
    format(
      'public.%I.%I expected %s%s',
      expected.table_name,
      expected.column_name,
      expected.data_type,
      CASE WHEN actual.column_name IS NULL THEN ' but is missing' ELSE format(' but found %s', actual.data_type) END
    ),
    ', ' ORDER BY expected.table_name, expected.column_name
  )
  INTO schema_errors
  FROM expected_columns expected
  LEFT JOIN information_schema.columns actual
    ON actual.table_schema = 'public'
   AND actual.table_name = expected.table_name
   AND actual.column_name = expected.column_name
  WHERE to_regclass(format('public.%I', expected.table_name)) IS NOT NULL
    AND (
      (actual.column_name IS NULL AND expected.is_required)
      OR (actual.column_name IS NOT NULL AND actual.data_type <> expected.data_type)
    );

  IF schema_errors IS NOT NULL THEN
    RAISE EXCEPTION 'Incompatible QuickShare schema: %', schema_errors;
  END IF;

  FOREACH existing_table_name IN ARRAY ARRAY['pages', 'audit_logs', 'api_keys']
  LOOP
    existing_table := to_regclass(format('public.%I', existing_table_name));

    IF existing_table IS NOT NULL THEN
      SELECT attribute_row.attnum::SMALLINT
      INTO id_attribute
      FROM pg_attribute attribute_row
      WHERE attribute_row.attrelid = existing_table
        AND attribute_row.attname = 'id'
        AND NOT attribute_row.attisdropped;

      IF id_attribute IS NULL OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid = existing_table
          AND constraint_row.contype = 'p'
          AND array_length(constraint_row.conkey, 1) = 1
          AND constraint_row.conkey[1] = id_attribute
      ) THEN
        RAISE EXCEPTION 'Incompatible QuickShare schema: public.% must have PRIMARY KEY (id)', existing_table_name;
      END IF;
    END IF;
  END LOOP;

  IF to_regclass('public.audit_logs') IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns audit_id
    WHERE audit_id.table_schema = 'public'
      AND audit_id.table_name = 'audit_logs'
      AND audit_id.column_name = 'id'
      AND (audit_id.is_identity = 'YES' OR audit_id.column_default LIKE 'nextval(%')
  ) THEN
    RAISE EXCEPTION 'Incompatible QuickShare schema: public.audit_logs.id must be generated';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.pages (
  id TEXT PRIMARY KEY,
  html_content TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  password_hash TEXT,
  encrypted_password TEXT,
  is_protected INTEGER DEFAULT 0,
  code_type TEXT DEFAULT 'html',
  title TEXT,
  description TEXT,
  expires_at BIGINT,
  markdown_theme TEXT,
  view_count BIGINT DEFAULT 0
);

ALTER TABLE public.pages
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS encrypted_password TEXT,
  ADD COLUMN IF NOT EXISTS is_protected INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS code_type TEXT DEFAULT 'html',
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS expires_at BIGINT,
  ADD COLUMN IF NOT EXISTS markdown_theme TEXT,
  ADD COLUMN IF NOT EXISTS view_count BIGINT DEFAULT 0;

ALTER TABLE public.pages
  ALTER COLUMN is_protected SET DEFAULT 0,
  ALTER COLUMN code_type SET DEFAULT 'html',
  ALTER COLUMN view_count SET DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_pages_created_at
  ON public.pages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pages_view_count
  ON public.pages (view_count DESC);

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  page_id TEXT,
  details TEXT,
  ip TEXT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON public.audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_page_id
  ON public.audit_logs (page_id);

CREATE TABLE IF NOT EXISTS public.api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_created_at
  ON public.api_keys (created_at DESC);
