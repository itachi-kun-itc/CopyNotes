import '../note-images.js';

const images = globalThis.CopyNotesImages;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// Each request and DB row contains at most 1 MiB of base64, independently of
// the original file size. Completed images are immutable and room-scoped.
export async function imageApi(request, db, room, { readJSON, json, ApiError }) {
  const parts = new URL(request.url).pathname.slice('/api/images'.length).split('/').filter(Boolean);
  if (!['GET', 'POST'].includes(request.method)) throw new ApiError(405, 'この操作は利用できません');
  if (!parts.length && request.method === 'POST') {
    const { id, mime, bytes } = await readJSON(request);
    if (!uuid.test(id) || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)
      || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > images.maxBytes) throw new ApiError(400, '20MiB以下の画像を指定してください');
    const count = Math.ceil(4 * Math.ceil(bytes / 3) / images.chunkLength);
    // Keep recent, unattached uploads for retries and concurrent edits. Remove
    // abandoned uploads and deleted originals after a day; chunks cascade.
    await db.prepare("DELETE FROM shared_images WHERE room_id = ? AND created_at < ? AND NOT EXISTS(SELECT 1 FROM shared_notes n, json_each(n.images) image WHERE n.room_id = shared_images.room_id AND n.deleted = 0 AND image.value = 'copynotes-image:' || shared_images.id)")
      .bind(room, Date.now() - 86400000).run();
    await db.prepare('INSERT INTO shared_images(room_id,id,mime,bytes,chunk_count,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(room_id,id) DO NOTHING')
      .bind(room, id, mime, bytes, count, Date.now()).run();
    const existing = await db.prepare('SELECT mime,bytes,chunk_count,complete FROM shared_images WHERE room_id = ? AND id = ?').bind(room, id).first();
    if (existing.mime !== mime || existing.bytes !== bytes) throw new ApiError(409, '画像のアップロードをやり直してください');
    return json({ complete: Boolean(existing.complete), chunks: count });
  }
  const [id, action] = parts;
  if (!uuid.test(id) || parts.length > 2) throw new ApiError(404, '画像が見つかりません');
  const image = await db.prepare('SELECT mime,bytes,chunk_count,complete FROM shared_images WHERE room_id = ? AND id = ?').bind(room, id).first();
  if (!image) throw new ApiError(404, '画像が見つかりません');
  if (action === 'complete' && request.method === 'POST') {
    const stats = await db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(data)),0) AS length FROM shared_image_chunks WHERE room_id = ? AND image_id = ?').bind(room, id).first();
    if (stats.count !== image.chunk_count || stats.length !== 4 * Math.ceil(image.bytes / 3)) throw new ApiError(409, '画像のアップロードが完了していません');
    await db.prepare('UPDATE shared_images SET complete = 1 WHERE room_id = ? AND id = ?').bind(room, id).run();
    return json({ complete: true });
  }
  if (action === undefined && request.method === 'GET' && image.complete) {
    return json({ mime: image.mime, bytes: image.bytes, chunks: image.chunk_count, complete: true });
  }
  if (!/^(0|[1-9][0-9]*)$/.test(action)) throw new ApiError(404, '画像が見つかりません');
  const index = Number(action);
  if (!Number.isSafeInteger(index) || index >= image.chunk_count) throw new ApiError(400, '画像の分割位置を確認してください');
  if (request.method === 'GET') {
    if (!image.complete) throw new ApiError(404, '画像が見つかりません');
    const chunk = await db.prepare('SELECT data FROM shared_image_chunks WHERE room_id = ? AND image_id = ? AND position = ?').bind(room, id, index).first();
    if (!chunk) throw new ApiError(404, '画像が見つかりません');
    return json(chunk);
  }
  const { data } = await readJSON(request);
  const length = 4 * Math.ceil(image.bytes / 3);
  const last = index === image.chunk_count - 1;
  const padding = last ? (3 - image.bytes % 3) % 3 : 0;
  const expected = last ? length - index * images.chunkLength : images.chunkLength;
  if (typeof data !== 'string' || data.length !== expected
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    || (data.match(/=*$/)[0].length !== padding)) throw new ApiError(400, '画像の分割データを確認してください');
  // The first successful value wins even if two retry requests overlap.
  await db.prepare('INSERT INTO shared_image_chunks(room_id,image_id,position,data) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM shared_images WHERE room_id = ? AND id = ? AND complete = 0) ON CONFLICT(room_id,image_id,position) DO NOTHING')
    .bind(room, id, index, data, room, id).run();
  const saved = await db.prepare('SELECT data FROM shared_image_chunks WHERE room_id = ? AND image_id = ? AND position = ?').bind(room, id, index).first();
  if (saved?.data !== data) throw new ApiError(409, '保存済みの画像は変更できません');
  return json({ saved: true });
}
