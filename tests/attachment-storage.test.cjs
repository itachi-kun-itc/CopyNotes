"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory, IDBObjectStore } = require('fake-indexeddb');
require('../note-images.js');
require('../attachment-storage.js');
require('../device-storage.js');
const attachments = CopyNotesAttachmentStorage, device = CopyNotesDeviceStorage;
const png = 'data:image/png;base64,aGVsbG8=';
function disk(initial = []) {
  const values = new Map(initial);
  return { get length() { return values.size; }, key: index => [...values.keys()][index],
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('three 20 MiB originals and shared conflict baselines survive reload with small localStorage metadata', async t => {
  const indexedDB = new IDBFactory(), storage = disk();
  const first = await attachments.open({ indexedDB, storage }); t.after(() => first.close());
  const notes = Array.from({ length: 3 }, (_, index) => device.draft('', [
    'data:image/png;base64,' + Buffer.alloc(CopyNotesImages.maxBytes, index + 1).toString('base64'),
  ]));
  await first.retain(notes);
  device.create(first).save(notes);
  first.setNotes('copynotes.shared.v4.room', notes.map(note => ({ ...note, originalImages: note.images, dirty: true, version: 0 })));
  assert.ok(storage.getItem(device.key).length < 1000);
  assert.ok(storage.getItem('copynotes.shared.v4.room').length < 2000);
  const second = await attachments.open({ indexedDB, storage }); t.after(() => second.close());
  const reloaded = device.create(second).load();
  assert.equal(reloaded.length, 3);
  for (let index = 0; index < 3; index++) {
    assert.equal(reloaded[index].images[0], notes[index].images[0]);
    assert.equal(second.getNotes('copynotes.shared.v4.room')[index].originalImages[0], notes[index].images[0]);
  }
});

test('legacy images migrate without changing IDs, text, image bytes or unrelated localStorage values', async t => {
  const notes = [{ id: 'old', text: '', images: [png] }, { id: 'text', text: 'copynotes-local-image:plain-text' }];
  const storage = disk([['copynotes.notes.v4', JSON.stringify(notes)], ['preferences', 'keep']]);
  const adapter = await attachments.open({ storage, indexedDB: new IDBFactory() }); t.after(() => adapter.close());
  assert.deepEqual(device.create(adapter).load(), notes);
  assert.match(storage.getItem('copynotes.notes.v4'), /copynotes-local-image:/);
  assert.equal(storage.getItem('preferences'), 'keep');
});

test('failed migration retains original image bytes and reports the storage error', async t => {
  const notes = [{ id: 'old', text: '', images: [png] }];
  const serialized = JSON.stringify(notes), storage = disk([[device.key, serialized]]), errors = [];
  t.mock.method(IDBObjectStore.prototype, 'put', () => { throw new Error('QuotaExceededError'); });
  const adapter = await attachments.open({ storage, indexedDB: new IDBFactory(), onError: error => errors.push(error) });
  t.after(() => adapter.close());
  assert.equal(errors.length, 1); assert.equal(storage.getItem(device.key), serialized);
  assert.deepEqual(device.create(adapter).load(), notes);
  await assert.rejects(adapter.put(png), /QuotaExceededError/);
});

test('another tab refreshes new durable images before merging device notes', async t => {
  const indexedDB = new IDBFactory(), storage = disk();
  const first = await attachments.open({ indexedDB, storage }); t.after(() => first.close());
  const second = await attachments.open({ indexedDB, storage }); t.after(() => second.close());
  const a = device.create(first), b = device.create(second);
  await second.put(png); b.save([{ id: 'photo', text: '', images: [png] }]);
  await first.refresh();
  const merged = a.save([{ id: 'text', text: 'keep both' }]);
  assert.deepEqual(merged.notes.map(note => note.id), ['photo', 'text']);
  assert.equal(merged.notes[0].images[0], png);
});

test('missing stored image references stop initialization without overwriting notes', async () => {
  const serialized = JSON.stringify([{ id: 'photo', text: '', images: ['copynotes-local-image:missing'] }]);
  const storage = disk([[device.key, serialized]]);
  await assert.rejects(attachments.open({ storage, indexedDB: new IDBFactory() }), /保存された画像/);
  assert.equal(storage.getItem(device.key), serialized);
});

test('old unreferenced originals are reclaimed and stale tabs can safely attach the same bytes again', async t => {
  const indexedDB = new IDBFactory(), storage = disk();
  const first = await attachments.open({ indexedDB, storage }); t.after(() => first.close());
  const actualNow = Date.now();
  t.mock.method(Date, 'now', () => actualNow - 2 * 86400000);
  await first.put(png);
  t.mock.restoreAll();
  // A second tab cleans up the old original, while the first still has a cache.
  const second = await attachments.open({ indexedDB, storage }); t.after(() => second.close());
  await first.put(png);
  first.setNotes(device.key, [{ id: 'new', text: '', images: [png] }]);
  await second.refresh();
  assert.equal(device.create(second).load()[0].images[0], png);
});
