CREATE TABLE public.site_settings (
  id SMALLINT PRIMARY KEY,
  homepage_password_required BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at BIGINT NOT NULL,
  CONSTRAINT site_settings_singleton CHECK (id = 1)
);

INSERT INTO public.site_settings (id, homepage_password_required, updated_at)
VALUES (1, TRUE, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT)
ON CONFLICT (id) DO NOTHING;
