-- Keep deletion metadata separate so deleted/blank memo records have no body row.
CREATE TABLE IF NOT EXISTS shared_note_deletions (
  room_id TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  sync_order INTEGER NOT NULL,
  sync_position INTEGER NOT NULL,
  synced_at INTEGER NOT NULL,
  mutation_id TEXT NOT NULL,
  PRIMARY KEY(room_id, id)
);
CREATE INDEX IF NOT EXISTS shared_note_deletions_order ON shared_note_deletions(room_id, sync_order, sync_position, id);

-- Match JavaScript String.trim(), including tabs, line breaks and full-width spaces.
INSERT OR IGNORE INTO shared_note_deletions(room_id, id, version, sync_order, sync_position, synced_at, mutation_id)
SELECT room_id, id, version + CASE WHEN deleted = 0 THEN 1 ELSE 0 END,
       sync_order, sync_position, synced_at, mutation_id
FROM shared_notes
WHERE deleted = 1 OR trim(content, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) = '';

DELETE FROM shared_notes
WHERE EXISTS(SELECT 1 FROM shared_note_deletions d WHERE d.room_id = shared_notes.room_id AND d.id = shared_notes.id);
