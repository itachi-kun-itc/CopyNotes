"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
require("../sharing.js");
const sharing = globalThis.CopyNotesSharing;
const remote = (id, text, version = 1, order = 1, mutationId = crypto.randomUUID()) => ({ id, text, version, order, position: 0, syncedAt: 1, deleted: false, mutationId });
const cache = note => sharing.merge([], [note]).notes[0];

test("refresh preserves unsynced edits and merges other devices' new notes", () => {
  const a = remote("a", "initial"); const local = cache(a); sharing.update(local, "local draft");
  const merged = sharing.merge([local], [a, remote("b", "another device", 1, 2)]);
  assert.equal(merged.notes[0].text, "local draft"); assert.equal(merged.notes[0].dirty, true);
  assert.equal(merged.notes[1].text, "another device");
});

test("acknowledgement cleans the same snapshot while newer local typing remains dirty", () => {
  const local = sharing.draft("first"); const sent = sharing.operations([local]);
  const accepted = remote(local.id, local.text, 1, 1, local.mutationId);
  assert.equal(sharing.merge([local], [accepted], sent).notes[0].dirty, false);
  sharing.update(local, "typed while syncing");
  const pending = sharing.merge([local], [accepted], sent).notes[0];
  assert.equal(pending.text, "typed while syncing"); assert.equal(pending.version, 1); assert.equal(pending.dirty, true);
});

test("concurrent edits preserve both versions and stale deletes preserve the remote note", () => {
  const original = remote("a", "initial"); const local = cache(original); sharing.update(local, "my edit");
  const result = sharing.merge([local], [remote("a", "their edit", 2, 2)]);
  assert.equal(result.copies, 1); assert.equal(result.notes[0].text, "their edit");
  assert.equal(result.notes[1].text, "my edit"); assert.equal(result.notes[1].version, 0); assert.equal(result.notes[1].dirty, true);
  sharing.remove(local);
  const deletion = sharing.merge([local], [remote("a", "new remote edit", 2, 2)]);
  assert.equal(deletion.deletions, 1); assert.equal(deletion.notes[0].deleted, false);
});

test("remote tombstones cannot erase unsynced text and reverting an edit clears dirty state", () => {
  const original = remote("a", "initial"); const local = cache(original); sharing.update(local, "draft");
  const merged = sharing.merge([local], [{ ...remote("a", "", 2, 2), deleted: true }]);
  assert.equal(merged.notes.filter(note => !note.deleted)[0].text, "draft");
  sharing.update(local, "initial"); assert.equal(local.dirty, false);
});

test("reverting text while a different snapshot uploads preserves the user's latest text", () => {
  const original = remote("a", "initial");
  const local = cache(original);
  sharing.update(local, "sent edit");
  const sent = sharing.operations([local]);
  sharing.update(local, "initial", true);
  const accepted = remote("a", "sent edit", 2, 2, sent[0].mutationId);
  const merged = sharing.merge([local], [accepted], sent).notes[0];
  assert.equal(merged.text, "initial"); assert.equal(merged.dirty, true); assert.equal(merged.version, 2);
});

test("blank cleanup removes empty drafts without touching nonblank source text or order", () => {
  for (const text of ["", " ", "\t\n", "\u3000\u00a0"]) assert.equal(sharing.isBlank(text), true);
  const code = sharing.draft("    print(1)\n");
  const last = sharing.draft("last");
  const notes = sharing.compactBlank([sharing.draft(), code, sharing.draft(" \n\t"), last]);
  assert.deepEqual(notes.map(note => note.id), [code.id, last.id]);
  assert.equal(notes[0].text, "    print(1)\n");
  assert.deepEqual(sharing.compactBlank([sharing.draft("")]), []);
});

test("blank synced notes become pending deletions and existing tombstones stay unchanged", () => {
  const synced = cache(remote("blank", " \t\n", 3, 5));
  const compacted = sharing.compactBlank([synced]);
  assert.equal(compacted[0].deleted, true); assert.equal(compacted[0].dirty, true);
  assert.equal(compacted[0].version, 3);
  assert.deepEqual(sharing.operations(compacted).map(note => ({ id: note.id, text: note.text, baseVersion: note.baseVersion, deleted: note.deleted })), [{ id: "blank", text: "", baseVersion: 3, deleted: true }]);
  assert.equal(sharing.compactBlank(compacted)[0].mutationId, compacted[0].mutationId);
});

test("closing during sync retains blank deletion until an acknowledged upload is removed", () => {
  const note = sharing.draft("text being uploaded");
  note.pendingMutationId = note.mutationId;
  const accepted = remote(note.id, note.text, 1, 1, note.mutationId);
  sharing.update(note, "", true);
  const closed = sharing.compactBlank([note], new Set([note.id]));
  assert.equal(closed[0].deleted, true);
  const restored = JSON.parse(JSON.stringify(closed));
  const merged = sharing.merge(restored, [accepted]);
  assert.equal(merged.notes[0].deleted, true); assert.equal(merged.notes[0].dirty, true); assert.equal(merged.notes[0].version, 1);
  assert.equal(sharing.operations(merged.notes)[0].baseVersion, 1);
});

test("only remote blank rows are cleaned on initial fetch, keeping a newly added local row", () => {
  const local = sharing.draft("");
  const blank = cache(remote("remote-blank", ""));
  const compacted = sharing.compactBlank([local, blank], new Set(), new Set([blank.id]));
  assert.equal(compacted[0].deleted, false);
  assert.equal(compacted[1].deleted, true);
});
