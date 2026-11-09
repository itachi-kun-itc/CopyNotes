"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../note-images.js');
require('../sharing.js');
require('../device-storage.js');
const images = CopyNotesImages, sharing = CopyNotesSharing, device = CopyNotesDeviceStorage;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const other = 'data:image/webp;base64,UklGRg==';

test('image validation permits three raster images and rejects unsafe URLs, excess images and oversized payloads', () => {
  for (const value of [undefined, [], [png], [png, png, png]]) assert.equal(images.valid(value), true);
  const boundary = 'data:image/png;base64,' + 'A'.repeat(4 * Math.ceil(images.maxBytes / 3));
  assert.equal(images.valid([boundary, boundary, boundary]), true);
  for (const value of [null, 'image', [png, png, png, png], ['https://example.com/p.png'], ['data:image/svg+xml;base64,PHN2Zz4='], ['data:image/png;base64,'], ['data:image/png;base64,%%=='], [boundary + 'AAAA']]) assert.equal(images.valid(value), false);
  assert.equal(images.isBlank({ text: ' \n', images: [png] }), false);
});

test('clipboard extraction uses image files once, ignores HTML/text and falls back to files', () => {
  const file = { type: 'image/png' };
  const item = { kind: 'file', type: file.type, getAsFile: () => file };
  assert.deepEqual(images.filesFrom({ items: [item, { kind: 'string', type: 'text/html' }], files: [file] }), [file]);
  assert.deepEqual(images.filesFrom({ files: [file, { type: 'text/plain' }] }), [file]);
  assert.deepEqual(images.filesFrom(null), []);
});

test('image-only device notes survive reload and simultaneous image edits preserve both copies', () => {
  const values = new Map();
  const disk = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const initial = device.create(disk); initial.save([device.draft('', [png])]);
  const a = device.create(disk), b = device.create(disk);
  const first = a.load(), second = b.load();
  first[0].images.push(other); a.save(first);
  second[0].images = [other];
  const merged = b.save(second);
  assert.deepEqual(merged.notes.map(note => note.images), [[png, other], [other]]);
  assert.equal(merged.preserved.length, 1);
  assert.deepEqual(device.create(disk).load().map(note => note.images), [[png, other], [other]]);
});

test('image-only shared notes sync, survive blank cleanup and preserve images through conflicts and in-flight edits', () => {
  const draft = sharing.draft('', [png]);
  assert.equal(sharing.operations([draft])[0].deleted, false);
  assert.equal(sharing.compactBlank([draft]).length, 1);
  const remote = { ...draft, version: 1, dirty: false };
  let local = sharing.merge([], [remote]).notes[0];
  sharing.update(local, '', false, [other]);
  const sent = sharing.operations([local]);
  sharing.update(local, '', true, [png, other]);
  const accepted = { ...remote, images: [other], version: 2, mutationId: sent[0].mutationId };
  local = sharing.merge([local], [accepted], sent).notes[0];
  assert.deepEqual(local.images, [png, other]); assert.equal(local.dirty, true);
  const conflict = sharing.merge([local], [{ ...accepted, version: 3, mutationId: 'someone-else' }]);
  assert.deepEqual(conflict.notes.find(note => !note.version).images, [png, other]);
  sharing.update(local, '', false, [other]); assert.equal(local.dirty, false);
  sharing.update(local, '', false, []); assert.equal(sharing.operations([local])[0].deleted, true);
  const big = 'data:image/png;base64,' + 'A'.repeat(4 * Math.ceil(images.maxBytes / 3));
  const operations = sharing.operations(Array.from({ length: 4 }, () => sharing.draft('', [big, big, big])));
  const batch = sharing.batch(operations);
  assert.equal(batch.length, 2);
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
  const draft = sharing.draft('', [png, png, png]);
  assert.equal((await send(sharing.operations([draft]))).status, 200);
  assert.deepEqual((await request('notes')).notes[0].images, [png, png, png]);
  const note = sharing.merge([], (await request('notes')).notes).notes[0];
  const invalid = { ...sharing.operations([draft])[0], images: [png, png, png, png] };
  const next = sharing.draft('must not be saved');
  assert.equal((await send([...sharing.operations([next]), invalid])).status, 400);
  assert.equal((await request('notes')).notes.length, 1);
  sharing.update(note, '', false, []);
  const deleted = await send(sharing.operations([note]));
  assert.equal(deleted.notes[0].deleted, true);
  assert.deepEqual(deleted.notes[0].images, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shared_notes').first().count, 0);
});
