-- Existing issued numbers retain their original shared workspace.
ALTER TABLE login_codes ADD COLUMN workspace TEXT NOT NULL DEFAULT 'shared'
  CHECK(workspace IN ('shared', 'group'));
