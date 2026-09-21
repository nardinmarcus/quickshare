ALTER TABLE site_settings
  ADD COLUMN publishing_writes_paused BOOLEAN NOT NULL DEFAULT FALSE;
