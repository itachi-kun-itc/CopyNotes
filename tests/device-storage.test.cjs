"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../device-storage.js');
const device = CopyNotesDeviceStorage;

function storage(legacy = ['first', 'second']) {
  const values = new Map(legacy === null ? [] : [['copynotes.notes.v1', JSON.stringify(legacy)]]);
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
const texts = notes => notes.map(note => note.text);

test('an unedited old tab cannot overwrite newer device notes on close or reload', () => {
  const disk = storage();
  const a = device.create(disk), b = device.create(disk);
  const local = a.load(); local[0].text = 'edited on A';
  a.save(local);
  assert.deepEqual(texts(b.save(b.load()).notes), ['edited on A', 'second']);
  assert.deepEqual(texts(device.create(disk).load()), ['edited on A', 'second']);
});

test('independent edits, additions and deletions from stale tabs are merged by ID', () => {
  const disk = storage(); const a = device.create(disk), b = device.create(disk);
  const first = a.load(); first[0].text = 'A'; first.push(device.draft('added on A'));
  a.save(first);
  const second = b.load(); second[1].text = 'B';
  let merged = b.save(second).notes;
  assert.deepEqual(texts(merged), ['A', 'B', 'added on A']);
  const c = device.create(disk); const original = c.load();
  merged = b.save(merged.filter(note => note.text !== 'A')).notes;
  assert.deepEqual(texts(c.save(original).notes), ['B', 'added on A']);
});

test('concurrent edits to the same note preserve both versions and the local focus ID', () => {
  const disk = storage(['original']); const a = device.create(disk), b = device.create(disk);
  const first = a.load(); first[0].text = 'A'; a.save(first);
  const second = b.load(); second[0].text = 'B';
  const merged = b.save(second);
  assert.deepEqual(texts(merged.notes), ['A', 'B']);
  assert.deepEqual(merged.preserved, [[second[0].id, merged.notes[1].id]]);
  assert.equal(new Set(merged.notes.map(note => note.id)).size, 2);
});

test('a stale deletion cannot erase a newer edit, and edits after deletion become a new note', () => {
  const disk = storage(['original']); const a = device.create(disk), b = device.create(disk);
  const first = a.load(); first[0].text = 'newer'; a.save(first);
  assert.deepEqual(texts(b.save([]).notes), ['newer']);
  const c = device.create(disk); const edit = c.load();
  b.save([]);
  edit[0].text = 'typed after deletion';
  const restored = c.save(edit).notes;
  assert.deepEqual(texts(restored), ['typed after deletion']);
  assert.notEqual(restored[0].id, edit[0].id);
});

test('legacy migration keeps text and order, removes blanks, and gives tabs the same IDs', () => {
  const disk = storage(['', '  source()\n', '\u3000', 'last']);
  const a = device.create(disk), b = device.create(disk);
  assert.deepEqual(a.load(), b.load());
  a.save(a.load()); b.save(b.load());
  const reloaded = device.create(disk).load();
  assert.deepEqual(texts(reloaded), ['  source()\n', 'last']);
  assert.deepEqual(reloaded, a.load());
});

test('failed saves retain changes for retry and an empty saved list stays empty', () => {
  const disk = storage(['original']); const setItem = disk.setItem;
  let fail = true, warnings = 0;
  disk.setItem = (...args) => { if (fail) throw new Error('quota'); setItem(...args); };
  const a = device.create(disk, () => warnings++);
  const edited = a.load(); edited[0].text = 'unsaved';
  const pending = a.save(edited).notes;
  assert.equal(warnings, 1);
  fail = false; a.save(pending);
  assert.deepEqual(texts(device.create(disk).load()), ['unsaved']);
  a.save([]);
  assert.deepEqual(device.create(disk).load(), []);
  assert.equal(device.create(storage(null)).load().length, 1);
});
