-- Preserve each image, its order, and its memo when reducing the image limit.
UPDATE shared_notes SET sync_position = sync_position * 3;
UPDATE shared_note_deletions SET sync_position = sync_position * 3;

INSERT INTO shared_notes(room_id, id, content, images, version, sync_order, sync_position, synced_at, deleted, mutation_id)
SELECT n.room_id, n.id || '-photo-' || (image.key + 1), '', json_array(image.value),
  1, n.sync_order, n.sync_position + image.key, n.synced_at, 0, lower(hex(randomblob(16)))
FROM shared_notes n, json_each(n.images) image WHERE n.deleted = 0 AND image.key > 0;

UPDATE shared_notes SET images = json_array(json_extract(images, '$[0]')),
  version = version + 1, mutation_id = lower(hex(randomblob(16)))
WHERE deleted = 0 AND json_array_length(images) > 1;
