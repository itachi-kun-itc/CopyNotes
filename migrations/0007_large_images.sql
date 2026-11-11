CREATE TABLE shared_images (
  room_id TEXT NOT NULL,
  id TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(room_id, id)
);

CREATE TABLE shared_image_chunks (
  room_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(room_id, image_id, position),
  FOREIGN KEY(room_id, image_id) REFERENCES shared_images(room_id, id) ON DELETE CASCADE
);
