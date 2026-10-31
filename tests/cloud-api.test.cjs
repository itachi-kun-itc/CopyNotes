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
  return async function request(path, method = "GET", body, extraHeaders = {}) {
    const { handleApi } = await api;
    const response = await handleApi(new Request(`https://copynotes.test/api/${path}`, {
      method, headers: { Cookie: cookie, Origin: "https://copynotes.test", "Content-Type": "application/json", ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { DB: db });
    if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
}
const operation = (id, text, baseVersion = 0, deleted = false, mutationId = crypto.randomUUID()) => ({ id, text, baseVersion, deleted, mutationId });
const sync = (operations, requestId = crypto.randomUUID()) => ({ requestId, operations });

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

test("login attempts are rate limited and expired sessions cannot read shared notes", async t => {
  const db = createDatabase(); t.after(() => db.close());
  const a = client(db);
  for (let i = 0; i < 10; i++) assert.equal((await a("auth", "POST", { code: "12345" })).status, 200);
  assert.equal((await a("auth", "POST", { code: "12345" })).status, 429);
  db.prepare("UPDATE sessions SET expires_at = 0").run();
  assert.equal((await a("notes")).status, 401);
});
