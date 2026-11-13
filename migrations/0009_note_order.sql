-- Manual order is independent of content versions and synchronization order.
CREATE TABLE IF NOT EXISTS shared_note_orders (
  room_id TEXT PRIMARY KEY,
  ids TEXT NOT NULL,
  revision INTEGER NOT NULL
);
