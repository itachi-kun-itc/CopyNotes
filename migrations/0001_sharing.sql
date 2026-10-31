CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  synced_at INTEGER NOT NULL,
  UNIQUE(room_id, request_id)
);

CREATE TABLE IF NOT EXISTS shared_notes (
  room_id TEXT NOT NULL,
  id TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL,
  sync_order INTEGER NOT NULL,
  sync_position INTEGER NOT NULL,
  synced_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1)),
  mutation_id TEXT NOT NULL,
  PRIMARY KEY(room_id, id)
);
CREATE INDEX IF NOT EXISTS shared_notes_order ON shared_notes(room_id, sync_order, sync_position, id);
