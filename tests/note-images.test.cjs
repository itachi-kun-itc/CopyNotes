"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../note-images.js');
require('../sharing.js');
require('../device-storage.js');
const images = CopyNotesImages, sharing = CopyNotesSharing, device = CopyNotesDeviceStorage;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const other = 'data:image/webp;base64,UklGRg==';
const third = 'data:image/png;base64,dGhpcmQ=';

test('image validation permits one raster image and rejects unsafe URLs, excess images and oversized payloads', () => {
  for (const value of [undefined, [], [png]]) assert.equal(images.valid(value), true);
  const boundary = 'data:image/png;base64,' + Buffer.alloc(images.maxBytes).toString('base64');
  assert.equal(images.valid([boundary]), true);
  for (const value of [null, 'image', [png, png], ['https://example.com/p.png'], ['data:image/svg+xml;base64,PHN2Zz4='], ['data:image/png;base64,'], ['data:image/png;base64,%%=='], [boundary + 'AAAA'], ['data:image/png;base64,' + Buffer.alloc(images.maxBytes + 1).toString('base64')]]) assert.equal(images.valid(value), false);
  assert.equal(images.isBlank({ text: ' \n', images: [png] }), false);
});

test('clipboard extraction uses image files once, ignores HTML/text and falls back to files', () => {
  const file = { type: 'image/png' };
  const item = { kind: 'file', type: file.type, getAsFile: () => file };
  assert.deepEqual(images.filesFrom({ items: [item, { kind: 'string', type: 'text/html' }], files: [file] }), [file]);
  assert.deepEqual(images.filesFrom({ files: [file, { type: 'text/plain' }] }), [file]);
  assert.deepEqual(images.filesFrom(null), []);
});

test('legacy device memos split text and all three images into stable separate memos', () => {
  const legacy = [{ id: 'legacy', text: 'keep text', images: [png, other, third] }];
  const values = new Map([['copynotes.notes.v2', JSON.stringify(legacy)]]);
  const disk = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const store = device.create(disk), notes = store.load();
  assert.deepEqual(notes.map(note => note.id), ['legacy', 'legacy-images-1', 'legacy-images-1-photo-2', 'legacy-images-2']);
  assert.deepEqual(notes.map(note => note.text), ['keep text', '', '', '']);
  assert.deepEqual(notes.flatMap(note => note.images || []), [png, other, third]);
  store.save(notes);
  assert.deepEqual(device.create(disk).load(), notes);
  assert.deepEqual(JSON.parse(values.get('copynotes.notes.v2')), legacy);
});

test('SQL migrations and cached shared memos split legacy images identically without conflicts or duplicates', () => {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs'), path = require('node:path');
  const db = new DatabaseSync(':memory:');
  try {
    const directory = path.join(__dirname, '../migrations');
    const migrations = fs.readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort();
    for (const name of migrations.filter(name => name < '0005')) db.exec(fs.readFileSync(path.join(directory, name), 'utf8'));
    const old = ['mixed', 'photos'].map((id, position) => ({ id, text: position ? '' : 'keep text', images: [png, other, third], version: 4,
      order: 1, position, syncedAt: 1, deleted: false, dirty: false, originalText: position ? '' : 'keep text', originalImages: [png, other, third], mutationId: 'original' }));
    const insert = db.prepare('INSERT INTO shared_notes(room_id,id,content,images,version,sync_order,sync_position,synced_at,deleted,mutation_id) VALUES(?,?,?,?,4,1,?,1,0,?)');
    for (const note of old) insert.run('room', note.id, note.text, JSON.stringify(note.images), note.position, note.mutationId);
    for (const name of migrations.filter(name => name >= '0005')) db.exec(fs.readFileSync(path.join(directory, name), 'utf8'));
    const incoming = db.prepare('SELECT * FROM shared_notes ORDER BY sync_order,sync_position,id').all().map(row => ({
      id: row.id, text: row.content, images: JSON.parse(row.images), version: row.version, order: row.sync_order, position: row.sync_position,
      syncedAt: row.synced_at, deleted: Boolean(row.deleted), mutationId: row.mutation_id,
    }));
    const local = sharing.normalizeLegacy(old);
    assert.equal(incoming.length, 7); assert.ok(incoming.every(images.validNote));
    assert.deepEqual(incoming.map(note => note.id), local.map(note => note.id));
    assert.deepEqual(incoming.flatMap(note => note.images), [png, other, third, png, other, third]);
    const merged = sharing.merge(local, incoming);
    assert.equal(merged.copies, 0); assert.equal(merged.notes.length, 7);
    assert.deepEqual(sharing.operations(merged.notes), []);
  } finally { db.close(); }
});

test('image-only device notes survive reload and simultaneous image edits preserve both copies', () => {
  const values = new Map();
  const disk = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const initial = device.create(disk); initial.save([device.draft('', [png])]);
  const a = device.create(disk), b = device.create(disk);
  const first = a.load(), second = b.load();
  first[0].images = [other]; a.save(first);
  second[0].images = [third];
  const merged = b.save(second);
  assert.deepEqual(merged.notes.map(note => note.images), [[other], [third]]);
  assert.equal(merged.preserved.length, 1);
  assert.deepEqual(device.create(disk).load().map(note => note.images), [[other], [third]]);
});

test('original image data at the size limit survives device storage and reload', () => {
  const src = 'data:image/png;base64,' + Buffer.alloc(images.maxBytes, 123).toString('base64');
  const values = new Map();
  const disk = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  device.create(disk).save([device.draft('', [src])]);
  assert.equal(device.create(disk).load()[0].images[0], src);
});

test('image-only shared notes sync, survive blank cleanup and preserve images through conflicts and in-flight edits', () => {
  const draft = sharing.draft('', [png]);
  assert.equal(sharing.operations([draft])[0].deleted, false);
  assert.equal(sharing.compactBlank([draft]).length, 1);
  const remote = { ...draft, version: 1, dirty: false };
  let local = sharing.merge([], [remote]).notes[0];
  sharing.update(local, '', false, [other]);
  const sent = sharing.operations([local]);
  sharing.update(local, '', true, [third]);
  const accepted = { ...remote, images: [other], version: 2, mutationId: sent[0].mutationId };
  local = sharing.merge([local], [accepted], sent).notes[0];
  assert.deepEqual(local.images, [third]); assert.equal(local.dirty, true);
  const conflict = sharing.merge([local], [{ ...accepted, version: 3, mutationId: 'someone-else' }]);
  assert.deepEqual(conflict.notes.find(note => !note.version).images, [third]);
  sharing.update(local, '', false, [other]); assert.equal(local.dirty, false);
  sharing.update(local, '', false, []); assert.equal(sharing.operations([local])[0].deleted, true);
  const big = 'data:image/png;base64,' + Buffer.alloc(images.maxBytes).toString('base64');
  const operations = sharing.operations(Array.from({ length: 8 }, () => sharing.draft('', [big])));
  const batch = sharing.batch(operations);
  assert.equal(batch.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify({ requestId: crypto.randomUUID(), operations: batch })) <= 2 * 1024 * 1024);
});

test('API saves image-only notes, enforces the limit atomically, and removes the body after deleting the last image', async t => {
  const { createDatabase } = require('../lib/sqlite-adapter.cjs');
  const admin = require('../lib/login-admin.cjs');
  const { handleApi } = await import('../lib/cloud-api.mjs');
  const db = createDatabase(); t.after(() => db.close());
  db.batch(admin.prepare(db, admin.issue('00123')));
  let cookie = '', room = '';
  async function request(path, body) {
    const response = await handleApi(new Request('https://copynotes.test/api/' + path, {
      method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: 'https://copynotes.test', 'Content-Type': 'application/json', 'X-CopyNotes-Room': room },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), { DB: db });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const result = await response.json();
    if (path === 'auth') room = result.roomId;
    return { status: response.status, ...result };
  }
  const send = operations => request('notes', { requestId: crypto.randomUUID(), operations });
  await request('auth', { code: '00123' });
  const original = 'data:image/png;base64,' + Buffer.alloc(images.maxBytes, 123).toString('base64');
  const draft = sharing.draft('', [original]);
  assert.equal((await send(sharing.operations([draft]))).status, 200);
  assert.deepEqual((await request('notes')).notes[0].images, [original]);
  const note = sharing.merge([], (await request('notes')).notes).notes[0];
  const invalid = { ...sharing.operations([draft])[0], images: [png, png] };
  const next = sharing.draft('must not be saved');
  assert.equal((await send([...sharing.operations([next]), invalid])).status, 400);
  assert.equal((await request('notes')).notes.length, 1);
  assert.equal((await send([...sharing.operations([next]), { ...invalid, images: [png], text: 'mixed' }])).status, 400);
  assert.equal((await request('notes')).notes.length, 1);
  const oversized = 'data:image/png;base64,' + Buffer.alloc(images.maxBytes + 1).toString('base64');
  assert.equal((await send([{ ...invalid, images: [oversized] }])).status, 400);
  assert.deepEqual((await request('notes')).notes[0].images, [original]);
  sharing.update(note, '', false, []);
  const deleted = await send(sharing.operations([note]));
  assert.equal(deleted.notes[0].deleted, true);
  assert.deepEqual(deleted.notes[0].images, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shared_notes').first().count, 0);
});
