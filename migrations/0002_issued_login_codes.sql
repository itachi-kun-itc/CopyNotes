CREATE TABLE IF NOT EXISTS login_codes (
  code_hash TEXT PRIMARY KEY,
  room_id TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL
);

-- Previously any five digits were accepted. None are automatically issued.
-- Remove existing login sessions as requested when switching to issued codes.
DELETE FROM sessions;
