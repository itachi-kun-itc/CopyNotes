"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../lib/sqlite-adapter.cjs');
const admin = require('../lib/login-admin.cjs');
require('../note-images.js');
require('../image-transfer.js');
require('../sharing.js');
const images = CopyNotesImages, sharing = CopyNotesSharing;
const api = import('../lib/cloud-api.mjs');
const png = 'data:image/png;base64,aGVsbG8=';
function setup(t) {
  const db = createDatabase(); t.after(() => db.close());
  for (const code of ['00123', '99999']) db.batch(admin.prepare(db, admin.issue(code)));
  return db;
}
function client(db, { pages = false } = {}) {
  let cookie = '', room = '', token = '';
  const requests = [];
  const request = async (path, method = 'GET', body, headers = {}) => {
    if (body !== undefined) assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 2 * 1024 * 1024, 'no request exceeds the existing API limit');
    requests.push({ path, method });
    const { handleApi } = await api;
    const response = await handleApi(new Request('https://copynotes.test/api/' + path, {
      method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CopyNotes-Room': room,
        Origin: pages ? 'https://itachi-kun-itc.github.io' : 'https://copynotes.test', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { DB: db });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    if (pages) assert.equal(response.headers.get('access-control-allow-origin'), 'https://itachi-kun-itc.github.io');
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error); error.status = response.status; throw error; }
    if (path === 'auth') { room = result.roomId || ''; token = result.sessionToken || ''; }
    return result;
  };
  return { request, requests, get room() { return room; } };
}
const send = (browser, operations) => browser.request('notes', 'POST', { requestId: crypto.randomUUID(), operations });

test('a 20 MiB original round-trips through chunks and notes for both Pages and native sessions', async t => {
  const db = setup(t), a = client(db, { pages: true }), b = client(db);
  await a.request('auth', 'POST', { code: '00123' }); await b.request('auth', 'POST', { code: '00123' });
  const src = 'data:image/png;base64,' + Buffer.alloc(images.maxBytes, 123).toString('base64');
  const local = [sharing.draft('', [src])];
  const transfer = CopyNotesImageTransfer.create(a.request);
  const sent = sharing.batch(sharing.operations(local)); assert.equal(sent.length, 1);
  const encoded = await transfer.encode(sent, a.room);
  assert.ok(images.referenceId(encoded[0].images[0]));
  const saved = await send(a, encoded);
  assert.equal(saved.notes[0].images[0], encoded[0].images[0]);
  const decoded = await CopyNotesImageTransfer.create(b.request).decode((await b.request('notes')).notes, b.room);
  assert.equal(decoded[0].images[0], src);
  assert.equal(sharing.merge(local, decoded, sent).notes[0].dirty, false);
  const row = db.prepare('SELECT MAX(length(data)) AS size,COUNT(*) AS count FROM shared_image_chunks').first();
  assert.equal(row.size, images.chunkLength); assert.equal(row.count, Math.ceil(4 * Math.ceil(images.maxBytes / 3) / images.chunkLength));
  assert.ok(db.prepare('SELECT length(images) AS size FROM shared_notes').first().size < 100);
  // Caches avoid re-uploading bytes when an acknowledgement has to be retried.
  const uploads = a.requests.filter(item => item.method === 'POST' && item.path.startsWith('images')).length;
  await transfer.encode(sent, a.room);
  assert.equal(a.requests.filter(item => item.method === 'POST' && item.path.startsWith('images')).length, uploads);
});

test('interrupted uploads retry the same chunks and completed originals are immutable', async t => {
  const db = setup(t), a = client(db); await a.request('auth', 'POST', { code: '00123' });
  const src = 'data:image/webp;base64,' + Buffer.alloc(2 * 1024 * 1024, 123).toString('base64');
  let fail = true;
  const transfer = CopyNotesImageTransfer.create(async (path, method, body) => {
    if (fail && path.endsWith('/1') && method === 'POST') { fail = false; throw new Error('offline'); }
    return a.request(path, method, body);
  });
  const operations = sharing.operations([sharing.draft('', [src])]);
  await assert.rejects(transfer.encode(operations, a.room), /offline/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shared_image_chunks').first().count, 1);
  const encoded = await transfer.encode(operations, a.room), id = images.referenceId(encoded[0].images[0]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shared_images').first().count, 1);
  await assert.rejects(a.request('images/' + id + '/0', 'POST', { data: 'A'.repeat(images.chunkLength) }), error => error.status === 409);
  await send(a, encoded);
  assert.equal((await CopyNotesImageTransfer.create(a.request).decode((await a.request('notes')).notes, a.room))[0].images[0], src);
});

test('partial, foreign-room, unauthenticated and stale-room images cannot be read or attached', async t => {
  const db = setup(t), a = client(db), b = client(db), guest = client(db);
  await a.request('auth', 'POST', { code: '00123' }); await b.request('auth', 'POST', { code: '99999' });
  const id = crypto.randomUUID(), reference = images.referencePrefix + id;
  await a.request('images', 'POST', { id, mime: 'image/png', bytes: 5 });
  const op = sharing.operations([sharing.draft('', [png])])[0]; op.images = [reference];
  await assert.rejects(send(a, [op]), error => error.status === 400);
  await assert.rejects(a.request('images/' + id + '/complete', 'POST', {}), error => error.status === 409);
  await assert.rejects(a.request('images/' + id), error => error.status === 404);
  await a.request('images/' + id + '/0', 'POST', { data: 'aGVsbG8=' });
  await a.request('images/' + id + '/complete', 'POST', {});
  await assert.rejects(b.request('images/' + id), error => error.status === 404);
  await assert.rejects(b.request('images/' + id + '/0'), error => error.status === 404);
  await assert.rejects(send(b, [op]), error => error.status === 400);
  await assert.rejects(guest.request('images/' + id), error => error.status === 401);
  await assert.rejects(a.request('images/' + id, 'GET', undefined, { 'X-CopyNotes-Room': b.room }), error => error.status === 401);
  await assert.rejects(a.request('images', 'POST', { id: crypto.randomUUID(), mime: 'image/png', bytes: images.maxBytes + 1 }), error => error.status === 400);
});

test('shared image memos are limited atomically to three per room, with retries, edits and replacement after deletion', async t => {
  const db = setup(t), a = client(db), b = client(db), other = client(db);
  await a.request('auth', 'POST', { code: '00123' }); await b.request('auth', 'POST', { code: '00123' }); await other.request('auth', 'POST', { code: '99999' });
  const operations = sharing.operations(Array.from({ length: 4 }, () => sharing.draft('', [png])));
  await send(a, operations.slice(0, 2));
  await send(b, operations.slice(2, 3));
  await assert.rejects(send(a, [...sharing.operations([sharing.draft('must roll back')]), operations[3]]), /3枚/);
  assert.equal((await a.request('notes')).notes.length, 3);
  await send(a, operations.slice(0, 3)); // Idempotent retries still work at the cap.
  await send(other, [operations[3]]);
  const notes = (await a.request('notes')).notes;
  await send(a, [{ ...operations[0], baseVersion: notes[0].version, mutationId: crypto.randomUUID() }]);
  const current = (await a.request('notes')).notes.find(note => note.id === operations[0].id);
  await send(a, [{ ...operations[0], baseVersion: current.version, deleted: true, images: [], mutationId: crypto.randomUUID() }]);
  await send(a, [operations[3]]);
  assert.equal((await a.request('notes')).notes.filter(note => !note.deleted && note.images.length).length, 3);
  const replacing = (await a.request('notes')).notes.find(note => note.id === operations[1].id);
  const replacement = sharing.operations([sharing.draft('', [png])])[0];
  await send(a, [replacement, { ...operations[1], baseVersion: replacing.version, deleted: true, images: [], mutationId: crypto.randomUUID() }]);
  assert.equal((await a.request('notes')).notes.filter(note => !note.deleted && note.images.length).length, 3);
});

test('garbage collection keeps attached and recent images and reclaims old abandoned chunks', async t => {
  const db = setup(t), a = client(db); await a.request('auth', 'POST', { code: '00123' });
  const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
  for (const id of ids) {
    await a.request('images', 'POST', { id, mime: 'image/png', bytes: 5 });
    await a.request('images/' + id + '/0', 'POST', { data: 'aGVsbG8=' });
    await a.request('images/' + id + '/complete', 'POST', {});
  }
  const op = sharing.operations([sharing.draft('', [png])])[0]; op.images = [images.referencePrefix + ids[0]];
  await send(a, [op]);
  db.prepare('UPDATE shared_images SET created_at = ? WHERE id IN (?,?)').bind(Date.now() - 2 * 86400000, ids[0], ids[1]).run();
  await a.request('images', 'POST', { id: crypto.randomUUID(), mime: 'image/png', bytes: 5 });
  assert.equal((await a.request('images/' + ids[0])).complete, true);
  assert.equal((await a.request('images/' + ids[2])).complete, true);
  await assert.rejects(a.request('images/' + ids[1]), error => error.status === 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shared_image_chunks WHERE image_id = ?').bind(ids[1]).first().count, 0);
});
