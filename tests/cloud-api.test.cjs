"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDatabase: openDatabase } = require("../lib/sqlite-adapter.cjs");
const admin = require("../lib/login-admin.cjs");
const api = import("../lib/cloud-api.mjs");

function createDatabase() {
  const db = openDatabase();
  for (const code of ["00123", "12345", "99999"]) db.batch(admin.prepare(db, admin.issue(code)));
  return db;
}

function client(db) {
  let cookie = "";
  let room = "";
  return async function request(path, method = "GET", body, extraHeaders = {}) {
    const { handleApi } = await api;
    const response = await handleApi(new Request(`https://copynotes.test/api/${path}`, {
      method, headers: { Cookie: cookie, Origin: "https://copynotes.test", "Content-Type": "application/json", "X-CopyNotes-Room": room, ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { DB: db });
    if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    const data = await response.json();
    if (path === 'auth' && response.ok) room = data.roomId || '';
    return { status: response.status, headers: response.headers, body: data };
  };
}
const operation = (id, text, baseVersion = 0, deleted = false, mutationId = crypto.randomUUID()) => ({ id, text, baseVersion, deleted, mutationId });
const sync = (operations, requestId = crypto.randomUUID()) => ({ requestId, operations });

test('manual shared order reaches another session, survives content sync and rejects old retries', async t => {
  const db = createDatabase(); t.after(() => db.close());
  const a = client(db), b = client(db), other = client(db);
  await a('auth', 'POST', { code: '00123' });
  await b('auth', 'POST', { code: '00123' });
  await other('auth', 'POST', { code: '99999' });
  await a('notes', 'POST', sync([operation('a', 'first'), operation('b', 'second'), operation('c', 'third')]));
  const before = db.prepare('SELECT id, content, version FROM shared_notes ORDER BY id').all().results;
  const first = { ids: ['c', 'a', 'b'], mutationId: crypto.randomUUID() };
  const saved = await a('note-order', 'POST', first);
  assert.equal(saved.status, 200);
  assert.deepEqual((await b('notes')).body.noteOrder, saved.body.noteOrder);
  assert.deepEqual(db.prepare('SELECT id, content, version FROM shared_notes ORDER BY id').all().results, before);
  const second = { ids: ['b', 'c', 'a'], mutationId: crypto.randomUUID() };
  const newer = await b('note-order', 'POST', second);
  assert.ok(newer.body.noteOrder.revision > saved.body.noteOrder.revision);
  assert.deepEqual((await a('note-order', 'POST', first)).body.noteOrder, newer.body.noteOrder);
  const edited = await a('notes', 'POST', sync([operation('a', 'updated first', 1)]));
  assert.deepEqual(edited.body.noteOrder.ids, second.ids, 'editing does not reset the manual order');
  assert.deepEqual((await other('notes')).body.noteOrder.ids, []);
  assert.deepEqual((await other('notes')).body.notes, []);
});

test('shared ordering validates IDs, authentication, origin and the active room before writing', async t => {
  const db = createDatabase(); t.after(() => db.close());
  const a = client(db);
  const valid = { ids: ['b', 'a'], mutationId: crypto.randomUUID() };
  assert.equal((await a('note-order', 'POST', valid)).status, 401);
  await a('auth', 'POST', { code: '00123' });
  assert.equal((await a('note-order', 'POST', valid, { 'X-CopyNotes-Room': 'wrong-room' })).status, 401);
  assert.equal((await a('note-order', 'POST', valid, { Origin: 'https://evil.test' })).status, 403);
  for (const body of [{}, { ...valid, ids: ['a', 'a'] }, { ...valid, ids: [3] }, { ...valid, ids: ['<script>'] },
    { ...valid, ids: Array.from({ length: 10001 }, (_, index) => String(index)) }, { ...valid, mutationId: '' }]) {
    assert.equal((await a('note-order', 'POST', body)).status, 400);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shared_note_orders').first().count, 0);
  assert.equal((await a('note-order', 'POST', valid)).status, 200);
});

test('stale tabs cannot read, write or log out a different cookie room', async t => {
  const db = createDatabase(); t.after(() => db.close());
  const browser = client(db);
  const first = await browser('auth', 'POST', { code: '00123' });
  const draft = operation('private-draft', 'draft belonging to A');
  await browser('auth', 'DELETE');
  const second = await browser('auth', 'POST', { code: '99999' });
  await browser('notes', 'POST', sync([operation('private-B', 'private B')]));
  const before = db.prepare('SELECT COUNT(*) AS count FROM sync_events').first().count;
  for (const room of [first.body.roomId, '']) {
    const headers = { 'X-CopyNotes-Room': room };
    const read = await browser('notes', 'GET', undefined, headers);
    assert.equal(read.status, 401); assert.equal(read.body.notes, undefined);
    assert.equal((await browser('notes', 'POST', sync([draft]), headers)).status, 401);
    assert.equal((await browser('auth', 'DELETE', undefined, headers)).status, 401);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_events').first().count, before);
  assert.deepEqual((await browser('notes')).body.notes.map(note => note.text), ['private B']);
  assert.equal((await browser('auth')).body.roomId, second.body.roomId);
  // Logging back into A can still send its retained draft to the correct room.
  await browser('auth', 'POST', { code: '00123' });
  assert.equal((await browser('notes', 'POST', sync([draft]))).status, 200);
  assert.deepEqual((await browser('notes')).body.notes.map(note => note.text), [draft.text]);
});

test('large valid emoji backlogs drain in batches without blocking later notes', async t => {
  require('../sharing.js');
  const sharing = CopyNotesSharing;
  const db = createDatabase(); t.after(() => db.close());
  const browser = client(db); await browser('auth', 'POST', { code: '00123' });
  let local = Array.from({ length: 200 }, () => sharing.draft('😀'.repeat(3000)));
  local.push(sharing.draft('last note'));
  const oversized = await browser('notes', 'POST', sync(sharing.operations(local).slice(0, 167)));
  assert.equal(oversized.status, 413);
  let requests = 0;
  while (sharing.operations(local).length) {
    const sent = sharing.batch(sharing.operations(local));
    assert.ok(sent.length > 0);
    const response = await browser('notes', 'POST', sync(sent));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.conflicts, []);
    local = sharing.merge(local, response.body.notes, sent).notes;
    assert.ok(++requests <= 3);
  }
  const result = (await browser('notes')).body.notes;
  assert.equal(result.length, 201);
  assert.equal(result.at(-1).text, 'last note');
  assert.ok(result.slice(0, 200).every(note => note.text === '😀'.repeat(3000)));
  assert.equal(requests, 2);
});

test("five ASCII digits including leading zeroes log in; other input is rejected", async t => {
  const db = createDatabase(); t.after(() => db.close());
  const a = client(db), b = client(db), other = client(db);
  assert.equal((await a("notes")).status, 401);
  for (const code of ["1234", "123456", "１２３４５", 12345, "12a45", " 12345"])
    assert.equal((await a("auth", "POST", { code })).status, 400);
  const login = await a("auth", "POST", { code: "00123" });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.match(login.headers.get("set-cookie"), /; Secure/);
  assert.equal((await b("auth", "POST", { code: "00123" })).body.roomId, login.body.roomId);
  assert.notEqual((await other("auth", "POST", { code: "12345" })).body.roomId, login.body.roomId);
  assert.equal((await a("auth")).body.authenticated, true);
  await a("auth", "DELETE");
  assert.equal((await a("notes")).status, 401);
});

test("independent sessions share only their room and notes follow server sync order", async t => {
  const db = createDatabase(); t.after(() => db.close());
  const a = client(db), b = client(db), other = client(db);
  await a("auth", "POST", { code: "00123" }); await b("auth", "POST", { code: "00123" }); await other("auth", "POST", { code: "99999" });
  const first = operation("first", "from device A"), second = operation("second", "from device B");
  await a("notes", "POST", sync([first]));
  assert.equal((await b("notes")).body.notes[0].text, first.text);
  await b("notes", "POST", sync([second]));
  assert.deepEqual((await a("notes")).body.notes.map(note => note.id), ["first", "second"]);
  assert.deepEqual((await other("notes")).body.notes, []);
  await a("notes", "POST", sync([operation("first", "updated on A", 1)]));
  assert.deepEqual((await b("notes")).body.notes.map(note => note.id), ["second", "first"]);
});

test("retries are idempotent and concurrent changes cannot silently overwrite notes", async t => {
  const db = createDatabase(); t.after(() => db.close());
  const a = client(db), b = client(db);
  await a("auth", "POST", { code: "12345" }); await b("auth", "POST", { code: "12345" });
  const first = operation("note", "initial");
  await a("notes", "POST", sync([first])); await a("notes", "POST", sync([first]));
  assert.equal((await a("notes")).body.notes[0].version, 1);
  const edit = operation("note", "A's edit", 1);
  await a("notes", "POST", sync([edit]));
  assert.equal((await a("notes", "POST", sync([edit]))).body.notes[0].version, 2);
  const stale = await b("notes", "POST", sync([operation("note", "B's stale edit", 1), operation("new", "new from B")]));
  assert.deepEqual(stale.body.conflicts, ["note"]);
  assert.equal(stale.body.notes.find(note => note.id === "note").text, "A's edit");
  assert.equal(stale.body.notes.find(note => note.id === "new").text, "new from B");
  await a("notes", "POST", sync([operation("note", "", 2, true)]));
  const tombstone = (await b("notes")).body.notes.find(note => note.id === "note");
  assert.equal(tombstone.deleted, true); assert.equal(tombstone.text, "");
  assert.deepEqual((await b("notes", "POST", sync([operation("note", "stale resurrection", 2)]))).body.conflicts, ["note"]);
});

test("cross-origin writes and invalid payloads are rejected without changing data", async t => {
  const db = createDatabase(); t.after(() => db.close());
  const a = client(db); await a("auth", "POST", { code: "12345" });
  assert.equal((await a("notes", "POST", sync([operation("x", "no")]), { Origin: "https://other.test" })).status, 403);
  assert.equal((await a("notes", "POST", sync([operation("x", "no"), operation("x", "duplicate")]))).status, 400);
  assert.equal((await a("notes", "POST", sync([operation("x", "x", -1)]))).status, 400);
  assert.equal((await a("notes", "POST", sync([operation("x", "a".repeat(100001))]))).status, 400);
  assert.deepEqual((await a("notes")).body.notes, []);
});

test("shared API accepts 3000 characters and atomically rejects longer notes without exposing the limit", async t => {
  const db = createDatabase(); t.after(() => db.close());
  const a = client(db); await a('auth', 'POST', { code: '12345' });
  for (const [id, character] of [['japanese', 'あ'], ['emoji', '😀']]) {
    const accepted = await a('notes', 'POST', sync([operation(id, character.repeat(3000))]));
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.notes.find(note => note.id === id).text, character.repeat(3000));
    const rejected = await a('notes', 'POST', sync([
      operation('not-written', 'valid text'), operation(id, character.repeat(3001), 1),
    ]));
    assert.equal(rejected.status, 400); assert.doesNotMatch(rejected.body.error, /3000|文字数/);
  }
  const notes = (await a('notes')).body.notes;
  assert.deepEqual(notes.map(note => note.id).sort(), ['emoji', 'japanese']);
  assert.ok(notes.every(note => note.version === 1 && Array.from(note.text).length === 3000));
});

test("login attempts are rate limited and expired sessions cannot read shared notes", async t => {
  const db = createDatabase(); t.after(() => db.close());
  const a = client(db);
  for (let i = 0; i < 10; i++) assert.equal((await a("auth", "POST", { code: "12345" })).status, 200);
  assert.equal((await a("auth", "POST", { code: "12345" })).status, 429);
  db.prepare("UPDATE sessions SET expires_at = 0").run();
  assert.equal((await a("notes")).status, 401);
});
