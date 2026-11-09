-- Leave room beside each existing position for its preserved image-only notes.
UPDATE shared_notes SET sync_position = sync_position * 3;
UPDATE shared_note_deletions SET sync_position = sync_position * 3;

INSERT INTO shared_notes(room_id, id, content, images, version, sync_order, sync_position, synced_at, deleted, mutation_id)
SELECT room_id, id || '-images-1', '',
  CASE WHEN json_array_length(images) = 1 THEN json_array(json_extract(images, '$[0]'))
    ELSE json_array(json_extract(images, '$[0]'), json_extract(images, '$[1]')) END,
  1, sync_order, sync_position + 1, synced_at, 0, lower(hex(randomblob(16)))
FROM shared_notes WHERE deleted = 0 AND content <> '' AND json_array_length(images) > 0;

INSERT INTO shared_notes(room_id, id, content, images, version, sync_order, sync_position, synced_at, deleted, mutation_id)
SELECT room_id, id || CASE WHEN content <> '' THEN '-images-2' ELSE '-images-1' END,
  '', json_array(json_extract(images, '$[2]')), 1, sync_order,
  sync_position + CASE WHEN content <> '' THEN 2 ELSE 1 END, synced_at, 0, lower(hex(randomblob(16)))
FROM shared_notes WHERE deleted = 0 AND json_array_length(images) > 2;

UPDATE shared_notes SET images = CASE WHEN content <> '' THEN '[]' ELSE json_remove(images, '$[2]') END,
  version = version + 1, mutation_id = lower(hex(randomblob(16)))
WHERE deleted = 0 AND (content <> '' AND json_array_length(images) > 0 OR json_array_length(images) > 2);
