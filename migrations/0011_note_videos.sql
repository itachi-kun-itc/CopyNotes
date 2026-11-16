ALTER TABLE shared_images ADD COLUMN duration REAL;

-- Video and image slots are independent. Triggers make the per-room cap
-- atomic across devices, including multiple simultaneous group members.
DROP TRIGGER shared_image_note_limit_insert;
DROP TRIGGER shared_image_note_limit_update;

CREATE TRIGGER shared_image_note_limit_insert BEFORE INSERT ON shared_notes
WHEN NEW.deleted = 0 AND NEW.images <> '[]' AND json_extract(NEW.images, '$[0]') NOT LIKE 'copynotes-video:%'
  AND NOT EXISTS(SELECT 1 FROM shared_notes WHERE room_id = NEW.room_id AND id = NEW.id)
  AND (SELECT COUNT(*) FROM shared_notes WHERE room_id = NEW.room_id AND deleted = 0 AND images <> '[]' AND json_extract(images, '$[0]') NOT LIKE 'copynotes-video:%') >= 3
BEGIN SELECT RAISE(ABORT, 'image_note_limit'); END;

CREATE TRIGGER shared_image_note_limit_update BEFORE UPDATE OF images, deleted ON shared_notes
WHEN NEW.deleted = 0 AND NEW.images <> '[]' AND json_extract(NEW.images, '$[0]') NOT LIKE 'copynotes-video:%'
  AND (OLD.deleted = 1 OR OLD.images = '[]' OR json_extract(OLD.images, '$[0]') LIKE 'copynotes-video:%')
  AND (SELECT COUNT(*) FROM shared_notes WHERE room_id = NEW.room_id AND id <> NEW.id AND deleted = 0 AND images <> '[]' AND json_extract(images, '$[0]') NOT LIKE 'copynotes-video:%') >= 3
BEGIN SELECT RAISE(ABORT, 'image_note_limit'); END;

CREATE TRIGGER shared_video_note_limit_insert BEFORE INSERT ON shared_notes
WHEN NEW.deleted = 0 AND json_extract(NEW.images, '$[0]') LIKE 'copynotes-video:%'
  AND NOT EXISTS(SELECT 1 FROM shared_notes WHERE room_id = NEW.room_id AND id = NEW.id)
  AND EXISTS(SELECT 1 FROM shared_notes WHERE room_id = NEW.room_id AND deleted = 0 AND json_extract(images, '$[0]') LIKE 'copynotes-video:%')
BEGIN SELECT RAISE(ABORT, 'video_note_limit'); END;

CREATE TRIGGER shared_video_note_limit_update BEFORE UPDATE OF images, deleted ON shared_notes
WHEN NEW.deleted = 0 AND json_extract(NEW.images, '$[0]') LIKE 'copynotes-video:%'
  AND EXISTS(SELECT 1 FROM shared_notes WHERE room_id = NEW.room_id AND id <> NEW.id AND deleted = 0 AND json_extract(images, '$[0]') LIKE 'copynotes-video:%')
BEGIN SELECT RAISE(ABORT, 'video_note_limit'); END;
