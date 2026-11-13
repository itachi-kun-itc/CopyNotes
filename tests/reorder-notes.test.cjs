"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../reorder-notes.js');

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
const items = ['a', 'b', 'c'].map(id => ({ id, text: id }));
const ids = values => values.map(value => value.id);

test('manual order survives reload, isolates workspaces and appends new notes without restoring deleted ones', () => {
  const disk = storage();
  const store = CopyNotesReorder.createOrderStore(disk);
  store.save('device', ['c', 'a', 'b']);
  const reloaded = CopyNotesReorder.createOrderStore(disk);
  assert.deepEqual(ids(reloaded.apply(items, 'device')), ['c', 'a', 'b']);
  assert.deepEqual(ids(reloaded.apply(items, 'shared.room-a')), ['a', 'b', 'c']);
  assert.deepEqual(ids(reloaded.apply([items[0], items[2], { id: 'new' }], 'device')), ['c', 'a', 'new']);
  assert.deepEqual(ids(items), ['a', 'b', 'c'], 'applying order never mutates the content model');
});

test('shared order preserves offline edits and further drags during upload, then accepts remote updates', () => {
  const disk = storage();
  const store = CopyNotesReorder.createOrderStore(disk);
  const key = 'shared.room-a';
  store.save(key, ['b', 'c', 'a']);
  const first = store.pending(key);
  assert.ok(first.mutationId);
  const reloaded = CopyNotesReorder.createOrderStore(disk);
  assert.deepEqual(reloaded.pending(key), first);
  reloaded.merge(key, { ids: ['a', 'b', 'c'], revision: 1 });
  assert.deepEqual(reloaded.pending(key), first, 'refresh cannot discard an unsent reorder');
  reloaded.save(key, ['c', 'b', 'a']);
  const second = reloaded.pending(key);
  reloaded.merge(key, { ids: first.ids, revision: 2 }, first);
  assert.deepEqual(reloaded.pending(key), second, 'an old acknowledgement cannot clear a newer drag');
  reloaded.merge(key, { ids: second.ids, revision: 3 }, second);
  assert.equal(reloaded.pending(key), null);
  reloaded.merge(key, { ids: ['b', 'a', 'c'], revision: 4 });
  reloaded.merge(key, { ids: ['a', 'b', 'c'], revision: 2 });
  assert.deepEqual(ids(reloaded.apply(items, key)), ['b', 'a', 'c']);
  assert.deepEqual(ids(reloaded.apply(items, 'shared.room-b')), ['a', 'b', 'c']);
});

test('storage failures retain the current session order even when old stored data remains readable', () => {
  const disk = storage();
  const store = CopyNotesReorder.createOrderStore(disk);
  store.save('device', ['c', 'a', 'b']);
  disk.setItem = () => { throw new Error('quota'); };
  store.save('device', ['b', 'a', 'c']);
  assert.deepEqual(ids(store.apply(items, 'device')), ['b', 'a', 'c']);
});
