"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { IDBFactory } = require('fake-indexeddb');
const { createDatabase } = require('../lib/sqlite-adapter.cjs');
const admin = require('../lib/login-admin.cjs');
require('../note-videos.js');
require('../note-images.js');
require('../sharing.js');
require('../device-storage.js');
const source = fs.readFileSync(require.resolve('../note-videos.js'), 'utf8');
const ref = () => CopyNotesVideos.prefix + crypto.randomUUID();
function browser({ indexedDB = new IDBFactory(), duration = 30, decodeError = false } = {}) {
  const revoked = [], writes = [], downloads = [];
  const context = vm.createContext({ indexedDB, Blob, Uint8Array, crypto, atob, btoa, setTimeout, clearTimeout,
    navigator: { clipboard: { writeText: async value => writes.push(value) } },
    URL: { createObjectURL: () => 'blob:original', revokeObjectURL: value => revoked.push(value) },
    document: { body: { append() {} }, createElement: tag => tag === 'video'
      ? { duration, removeAttribute() {}, load() {}, set src(value) { queueMicrotask(() => decodeError ? this.onerror() : this.onloadedmetadata()); } }
      : { click() { downloads.push({ name: this.download, href: this.href }); }, remove() {} } },
  });
  vm.runInContext(source, context);
  return { videos: context.CopyNotesVideos, revoked, writes, downloads, indexedDB };
}
const bytes = Buffer.from('original video bytes: no transcoding');
const metadata = { mime: 'video/mp4', bytes: bytes.length, duration: 30 };

test('video boundaries are exactly 30 seconds and 300 decimal MB, with strict metadata and reference validation', () => {
  assert.equal(CopyNotesVideos.validMetadata({ ...metadata, bytes: 300000000 }), true);
  for (const value of [{ bytes: 300000001 }, { bytes: 0 }, { bytes: 1.5 }, { duration: 30.001 }, { duration: Infinity }, { duration: 0 }, { mime: 'text/html' }]) {
    assert.equal(CopyNotesVideos.validMetadata({ ...metadata, ...value }), false);
  }
  assert.ok(CopyNotesVideos.referenceId(ref()));
  for (const value of [null, 'blob:test', 'https://test/video.mp4', 'copynotes-video:no']) assert.equal(CopyNotesVideos.referenceId(value), null);
});

test('preparation checks file size and decoded duration, saves the original Blob durably, and rejects unreadable files', async () => {
  const a = browser(), blob = new Blob([bytes], { type: metadata.mime });
  const reference = await a.videos.prepare(blob);
  assert.equal(a.revoked.length, 1);
  const reloaded = browser({ indexedDB: a.indexedDB });
  const saved = await reloaded.videos.get(reference);
  assert.equal(saved.duration, 30);
  assert.deepEqual(Buffer.from(await saved.blob.arrayBuffer()), bytes);
  await assert.rejects(a.videos.prepare({ type: metadata.mime, size: 300000001 }), /300MB/);
  await assert.rejects(browser({ duration: 30.001 }).videos.prepare(blob), /30秒/);
  await assert.rejects(browser({ duration: Infinity }).videos.prepare(blob), /長さ/);
  await assert.rejects(browser({ decodeError: true }).videos.prepare(blob), /読み込めません/);
  await assert.rejects(a.videos.prepare(new Blob([bytes], { type: 'text/html' })), /対応する動画/);
});

test('video references survive device reload, shared merge, copy and original-file download without embedding bytes', async () => {
  const a = browser(), reference = await a.videos.prepare(new Blob([bytes], { type: metadata.mime }));
  const values = new Map(), disk = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  CopyNotesDeviceStorage.create(disk).save([CopyNotesDeviceStorage.draft('', [reference])]);
  assert.equal(CopyNotesDeviceStorage.create(disk).load()[0].images[0], reference);
  assert.ok(values.get(CopyNotesDeviceStorage.key).length < 200);
  const draft = CopyNotesSharing.draft('', [reference]);
  const sent = CopyNotesSharing.operations([draft]);
  assert.equal(CopyNotesSharing.merge([draft], [{ ...draft, version: 1 }], sent).notes[0].dirty, false);
  await a.videos.copy(reference);
  assert.equal(a.videos.fromClipboard({ getData: () => a.writes[0] }), reference);
  assert.equal(a.videos.fromClipboard({ getData: () => 'ordinary text' }), null);
  await a.videos.download(reference);
  assert.equal(a.downloads[0].name, 'copynotes-video.mp4');
});

async function fixture(t) {
  const db = createDatabase(); t.after(() => db.close());
  for (const code of ['00123', '99999', 'G0123', 'G9999']) db.batch(admin.prepare(db, admin.issue(code)));
  const { handleApi } = await import('../lib/cloud-api.mjs');
  async function client(code, pages = false) {
    let cookie = '', token = '', room = '';
    const workspace = code.startsWith('G') ? 'group' : 'shared';
    const request = async (path, method = 'GET', body) => {
      if (body) assert.ok(Buffer.byteLength(JSON.stringify(body)) < 2 * 1024 * 1024);
      const response = await handleApi(new Request('https://copynotes.test/api/' + path, {
        method, headers: { Cookie: cookie, Origin: pages ? 'https://itachi-kun-itc.github.io' : 'https://copynotes.test',
          'Content-Type': 'application/json', 'X-CopyNotes-Room': room, 'X-CopyNotes-Workspace': workspace,
          ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
      }), { DB: db });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      if (pages) assert.equal(response.headers.get('access-control-allow-origin'), 'https://itachi-kun-itc.github.io');
      const result = await response.json();
      if (!response.ok) { const error = new Error(result.error); error.status = response.status; throw error; }
      if (path === 'auth') { room = result.roomId; token = result.sessionToken || ''; }
      return result;
    };
    await request('auth', 'POST', { code });
    return { request, get room() { return room; }, send: operations => request('notes', 'POST', { requestId: crypto.randomUUID(), operations }) };
  }
  return { db, client };
}

test('chunked video transfer retries interruptions and round-trips original bytes across Pages and native sessions', async t => {
  const { client, db } = await fixture(t), a = await client('00123', true), b = await client('00123');
  const original = Buffer.alloc(2 * 1024 * 1024 + 1, 123), local = browser(), remote = browser(), reference = ref();
  await local.videos.put(reference, new Blob([original], { type: metadata.mime }), { ...metadata, bytes: original.length });
  let interrupted = true;
  const transfer = local.videos.createTransfer(async (path, method, body) => {
    if (interrupted && path.endsWith('/1') && method === 'POST') { interrupted = false; throw new Error('offline'); }
    return a.request(path, method, body);
  });
  await assert.rejects(transfer.upload(reference, a.room), /offline/);
  await transfer.upload(reference, a.room);
  await transfer.upload(reference, a.room);
  await a.send(CopyNotesSharing.operations([CopyNotesSharing.draft('', [reference])]));
  await remote.videos.createTransfer(b.request).download(reference, b.room);
  const record = await remote.videos.get(reference);
  assert.deepEqual(Buffer.from(await record.blob.arrayBuffer()), original);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shared_images').first().count, 1);
  assert.ok(db.prepare('SELECT MAX(length(data)) AS size FROM shared_image_chunks').first().size <= 1024 * 1024);
  const foreign = await client('99999');
  await assert.rejects(foreign.request('images/' + CopyNotesVideos.referenceId(reference)), error => error.status === 404);
  await assert.rejects(foreign.send(CopyNotesSharing.operations([CopyNotesSharing.draft('', [reference])])), error => error.status === 400);
  await assert.rejects(a.request('images/' + CopyNotesVideos.referenceId(reference) + '/0', 'POST', { data: 'A'.repeat(1024 * 1024) }), error => error.status === 409);
});

test('the API enforces duration and size and rejects incomplete video references and type confusion', async t => {
  const { client } = await fixture(t), a = await client('00123');
  for (const change of [{ bytes: 300000001 }, { duration: 31 }, { duration: null }, { mime: 'video/unsupported' }]) {
    await assert.rejects(a.request('images', 'POST', { id: crypto.randomUUID(), ...metadata, ...change }), error => error.status === 400);
  }
  const id = crypto.randomUUID();
  await a.request('images', 'POST', { id, ...metadata, bytes: 300000000 });
  const reference = CopyNotesVideos.prefix + id;
  await assert.rejects(a.send(CopyNotesSharing.operations([CopyNotesSharing.draft('', [reference])])), error => error.status === 400);
  await assert.rejects(a.request('images/' + id + '/complete', 'POST', {}), error => error.status === 409);
  const complete = crypto.randomUUID();
  await a.request('images', 'POST', { id: complete, ...metadata });
  await a.request('images/' + complete + '/0', 'POST', { data: bytes.toString('base64') });
  await a.request('images/' + complete + '/complete', 'POST', {});
  await assert.rejects(a.send(CopyNotesSharing.operations([CopyNotesSharing.draft('', ['copynotes-image:' + complete])])), error => error.status === 400);
});

test('three people cannot exceed one video in either shared or group rooms; images, retries and replacement remain independent', async t => {
  const { client } = await fixture(t);
  for (const code of ['00123', 'G0123']) {
    const people = await Promise.all([client(code), client(code, true), client(code)]);
    const operations = [];
    for (let index = 0; index < people.length; index++) {
      const reference = ref(), id = CopyNotesVideos.referenceId(reference);
      await people[index].request('images', 'POST', { id, ...metadata });
      await people[index].request('images/' + id + '/0', 'POST', { data: bytes.toString('base64') });
      await people[index].request('images/' + id + '/complete', 'POST', {});
      operations.push(...CopyNotesSharing.operations([CopyNotesSharing.draft('', [reference])]));
    }
    const results = await Promise.allSettled(people.map((person, index) => person.send([operations[index]])));
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    for (const result of results.filter(value => value.status === 'rejected')) assert.match(result.reason.message, /1本/);
    const a = people[0], note = (await a.request('notes')).notes.find(note => !note.deleted);
    const original = operations.find(operation => operation.id === note.id);
    await a.send([original]);
    await a.send(CopyNotesSharing.operations(Array.from({ length: 3 }, () => CopyNotesSharing.draft('', ['data:image/png;base64,aGVsbG8=']))));
    const replacement = operations.find(operation => operation.id !== note.id);
    await a.send([replacement, { ...original, baseVersion: note.version, mutationId: crypto.randomUUID(), deleted: true, images: [] }]);
    const current = (await a.request('notes')).notes.filter(note => !note.deleted);
    assert.equal(current.filter(note => CopyNotesVideos.referenceId(note.images[0])).length, 1);
    assert.equal(current.filter(note => note.images[0]?.startsWith('data:image')).length, 3);
  }
});
