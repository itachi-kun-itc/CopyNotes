"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createDatabase } = require("../lib/sqlite-adapter.cjs");
const admin = require("../lib/login-admin.cjs");
require("../sharing.js");
const sharing = globalThis.CopyNotesSharing;
const api = import("../lib/cloud-api.mjs");
const whitespace = [9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279];
const op = (id, text, baseVersion = 0, deleted = false, mutationId = crypto.randomUUID()) => ({ id, text, baseVersion, deleted, mutationId });

function setup(t) {
  const db = createDatabase(); t.after(() => db.close());
  for (const code of ["00123", "99999"]) db.batch(admin.prepare(db, admin.issue(code)));
  function client() {
    let cookie = "";
    return async (endpoint, method = "GET", body) => {
      const { handleApi } = await api;
      const response = await handleApi(new Request("https://copynotes.test/api/" + endpoint, {
        method, headers: { Origin: "https://copynotes.test", Cookie: cookie, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }), { DB: db });
      if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
      return { status: response.status, body: await response.json() };
    };
  }
  return { db, client };
}
const send = (client, operations, requestId = crypto.randomUUID()) => client("notes", "POST", { requestId, operations });

test("empty and Unicode-whitespace syncs physically remove note bodies even without a deleted flag", async t => {
  const { db, client } = setup(t); const a = client(); await a("auth", "POST", { code: "00123" });
  for (const [index, blank] of ["", " \t\r\n", "\u3000\u00a0", String.fromCodePoint(...whitespace)].entries()) {
    const id = "blank-" + index;
    await send(a, [op(id, "previous text")]);
    const clear = op(id, blank, 1);
    const result = await send(a, [clear]);
    assert.equal(result.status, 200); assert.deepEqual(result.body.conflicts, []);
    const deleted = result.body.notes.find(note => note.id === id);
    assert.equal(deleted.deleted, true); assert.equal(deleted.text, ""); assert.equal(deleted.mutationId, clear.mutationId);
    assert.equal(db.prepare("SELECT * FROM shared_notes WHERE id = ?").bind(id).first(), null);
    assert.equal(db.prepare("SELECT version FROM shared_note_deletions WHERE id = ?").bind(id).first().version, 2);
  }
  assert.ok(!db.prepare("PRAGMA table_info(shared_note_deletions)").all().results.some(column => column.name === "content"));
});

test("first-time blank syncs create no body; nonblank whitespace and separate rooms stay intact", async t => {
  const { db, client } = setup(t); const a = client(); const b = client();
  await a("auth", "POST", { code: "00123" }); await b("auth", "POST", { code: "99999" });
  await send(a, [op("same-id", " \n\u3000")]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shared_notes").first().count, 0);
  const text = "    code()\n\t";
  await send(b, [op("same-id", text)]);
  assert.equal((await b("notes")).body.notes[0].text, text);
  assert.equal((await a("notes")).body.notes[0].deleted, true);
  await send(a, [op("nonblank", "\u200b")]);
  assert.equal(db.prepare("SELECT content FROM shared_notes WHERE id = 'nonblank'").first().content, "\u200b");
});

test("stale blank syncs cannot erase newer edits, and retries cannot resurrect a removed body", async t => {
  const { db, client } = setup(t); const a = client(); const b = client();
  await a("auth", "POST", { code: "00123" }); await b("auth", "POST", { code: "00123" });
  const original = op("note", "original"); await send(a, [original]);
  await send(b, [op("note", "newer edit", 1)]);
  const stale = await send(a, [op("note", "\t\n", 1)]);
  assert.deepEqual(stale.body.conflicts, ["note"]);
  assert.equal(db.prepare("SELECT content FROM shared_notes WHERE id = 'note'").first().content, "newer edit");
  const clear = op("note", "", 2); const requestId = crypto.randomUUID();
  await send(a, [clear], requestId);
  for (const retryId of [requestId, crypto.randomUUID()]) {
    const retried = await send(a, [clear], retryId);
    assert.deepEqual(retried.body.conflicts, []); assert.equal(retried.body.notes[0].version, 3);
  }
  assert.deepEqual((await send(b, [original])).body.conflicts, ["note"]);
  assert.deepEqual((await send(b, [op("note", "stale update", 2)])).body.conflicts, ["note"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shared_notes").first().count, 0);
});

test("reading cleans legacy blanks and records written by an old deployment without crossing rooms", async t => {
  const { db, client } = setup(t); const a = client(); const b = client();
  const first = (await a("auth", "POST", { code: "00123" })).body.roomId;
  const second = (await b("auth", "POST", { code: "99999" })).body.roomId;
  const insert = (room, id, content) => db.prepare("INSERT INTO shared_notes VALUES(?, ?, ?, 1, 1, 0, 1, 0, ?)").bind(room, id, content, crypto.randomUUID()).run();
  insert(first, "legacy", "\u3000\t\n"); insert(second, "legacy", " \n");
  assert.equal((await a("notes")).body.notes[0].deleted, true);
  assert.equal(db.prepare("SELECT * FROM shared_notes WHERE room_id = ?").bind(first).first(), null);
  assert.ok(db.prepare("SELECT * FROM shared_notes WHERE room_id = ?").bind(second).first());
  insert(first, "legacy", "old deployment retried creation");
  const result = await a("notes");
  assert.equal(result.body.notes.length, 1); assert.equal(result.body.notes[0].deleted, true);
  assert.equal(db.prepare("SELECT * FROM shared_notes WHERE room_id = ?").bind(first).first(), null);
});

test("migration removes existing blank/deleted bodies and preserves nonblank source exactly", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(fs.readFileSync(path.join(__dirname, "../migrations/0001_sharing.sql"), "utf8"));
    const insert = db.prepare("INSERT INTO shared_notes VALUES('room', ?, ?, 3, 1, 0, 1, ?, ?)");
    for (const code of whitespace) insert.run("blank-" + code, String.fromCodePoint(code), 0, "m" + code);
    insert.run("deleted", "", 1, "deleted");
    const code = "    print(1)\n\t"; insert.run("keep", code, 0, "keep");
    const migration = fs.readFileSync(path.join(__dirname, "../migrations/0003_remove_blank_notes.sql"), "utf8");
    db.exec(migration); db.exec(migration);
    assert.deepEqual(db.prepare("SELECT id, content, version FROM shared_notes").all().map(row => ({ ...row })), [{ id: "keep", content: code, version: 3 }]);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shared_note_deletions").get().count, whitespace.length + 1);
    assert.equal(db.prepare("SELECT version FROM shared_note_deletions WHERE id = 'deleted'").get().version, 3);
    assert.equal(db.prepare("SELECT version FROM shared_note_deletions WHERE id = 'blank-12288'").get().version, 4);
  } finally { db.close(); }
});

test("typing during a blank upload is preserved under a new ID that can sync after physical deletion", async t => {
  const { db, client } = setup(t); const a = client(); await a("auth", "POST", { code: "00123" });
  const created = await send(a, [op("active", "initial")]);
  const local = sharing.merge([], created.body.notes).notes[0];
  sharing.update(local, " \t\n");
  const sent = sharing.operations([local]);
  assert.equal(sent[0].deleted, true); assert.equal(sent[0].text, "");
  local.pendingMutationId = sent[0].mutationId;
  const cleared = await send(a, sent);
  sharing.update(local, "typed while deletion was uploading", true);
  const merged = sharing.merge([local], cleared.body.notes, sent);
  const preserved = merged.notes.find(note => !note.deleted);
  assert.notEqual(preserved.id, "active"); assert.equal(preserved.version, 0);
  assert.deepEqual(merged.preserved, [["active", preserved.id]]);
  const saved = await send(a, sharing.operations(merged.notes));
  assert.deepEqual(saved.body.conflicts, []);
  assert.equal(db.prepare("SELECT content FROM shared_notes").first().content, "typed while deletion was uploading");
  assert.equal(db.prepare("SELECT * FROM shared_notes WHERE id = 'active'").first(), null);
});

test("blank acknowledgement removes whitespace drafts without creating another blank conflict copy", () => {
  const original = { id: "blank", text: "initial", version: 1, order: 1, mutationId: "original", deleted: false };
  const local = sharing.merge([], [original]).notes[0];
  sharing.update(local, " "); const sent = sharing.operations([local]);
  sharing.update(local, " \n\t", true);
  const merged = sharing.merge([local], [{ ...original, text: "", deleted: true, version: 2, mutationId: sent[0].mutationId }], sent);
  assert.equal(merged.notes.filter(note => !note.deleted).length, 0);
  assert.equal(sharing.operations(merged.notes).length, 0);
  const staleBlank = sharing.merge([local], [{ ...original, text: "newer nonblank", version: 2, mutationId: "newer" }]);
  assert.equal(staleBlank.copies, 0); assert.equal(staleBlank.deletions, 1);
  assert.equal(staleBlank.notes.length, 1); assert.equal(staleBlank.notes[0].text, "newer nonblank");
});
