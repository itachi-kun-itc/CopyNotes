-- Existing attachments remain readable. Only adding a new image memo is capped.
CREATE TRIGGER shared_image_note_limit_insert BEFORE INSERT ON shared_notes
WHEN NEW.deleted = 0 AND NEW.images <> '[]'
  AND NOT EXISTS(SELECT 1 FROM shared_notes WHERE room_id = NEW.room_id AND id = NEW.id)
  AND (SELECT COUNT(*) FROM shared_notes WHERE room_id = NEW.room_id AND deleted = 0 AND images <> '[]') >= 3
BEGIN
  SELECT RAISE(ABORT, 'image_note_limit');
END;

CREATE TRIGGER shared_image_note_limit_update BEFORE UPDATE OF images ON shared_notes
WHEN NEW.deleted = 0 AND NEW.images <> '[]' AND (OLD.deleted = 1 OR OLD.images = '[]')
  AND (SELECT COUNT(*) FROM shared_notes WHERE room_id = NEW.room_id AND deleted = 0 AND images <> '[]') >= 3
BEGIN
  SELECT RAISE(ABORT, 'image_note_limit');
END;
