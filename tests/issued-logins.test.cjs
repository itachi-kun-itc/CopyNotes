"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDatabase } = require("../lib/sqlite-adapter.cjs");
const admin = require("../lib/login-admin.cjs");
const api = import("../lib/cloud-api.mjs");

function client(db) {
  let cookie = "";
  return async (path, method = "GET", body) => {
    const { handleApi } = await api;
    const response = await handleApi(new Request(`https://copynotes.test/api/${path}`, {
      method, headers: { Cookie: cookie, Origin: "https://copynotes.test", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { DB: db });
    if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    return { status: response.status, body: await response.json() };
  };
}
function setup(t, codes = ["00123", "12345"]) {
  const db = createDatabase(); t.after(() => db.close());
  for (const code of codes) db.batch(admin.prepare(db, admin.issue(code)));
  return db;
}
const sync = (id, text, baseVersion = 0) => ({ requestId: crypto.randomUUID(), operations: [{ id, text, baseVersion, deleted: false, mutationId: crypto.randomUUID() }] });

test("a valid-looking but unissued number is rejected and never self-registers", async t => {
  const db = setup(t); const a = client(db);
  const result = await a("auth", "POST", { code: "54321", create: true });
  assert.equal(result.status, 401); assert.match(result.body.error, /無効なログイン番号/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM login_codes").first().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").first().count, 0);
});

test("deleting a code revokes every session; reissuing creates a fresh room", async t => {
  const db = setup(t); const a = client(db), b = client(db), other = client(db);
  const first = await a("auth", "POST", { code: "12345" });
  await b("auth", "POST", { code: "12345" }); await other("auth", "POST", { code: "00123" });
  await a("notes", "POST", sync("private-note", "old room data"));
  db.batch(admin.prepare(db, admin.remove("12345")));
  assert.equal((await a("auth")).body.authenticated, false); assert.equal((await b("notes")).status, 401);
  assert.equal((await other("auth")).body.authenticated, true);
  assert.equal((await a("auth", "POST", { code: "12345" })).status, 401);
  db.batch(admin.prepare(db, admin.issue("12345")));
  const next = await a("auth", "POST", { code: "12345" });
  assert.notEqual(next.body.roomId, first.body.roomId); assert.deepEqual((await a("notes")).body.notes, []);
});

test("registry removal blocks old cookies even before session cleanup", async t => {
  const db = setup(t); const a = client(db); await a("auth", "POST", { code: "12345" });
  db.prepare("DELETE FROM login_codes WHERE code_hash = ?").bind(admin.codeHash("12345")).run();
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").first().count, 1);
  assert.equal((await a("notes")).status, 401);
  assert.equal((await a("notes", "POST", sync("unauthorized", "no"))).status, 401);
});

test("deleting all codes clears all sessions; no public endpoint can issue a code", async t => {
  const db = setup(t); const a = client(db), b = client(db);
  await a("auth", "POST", { code: "12345" }); await b("auth", "POST", { code: "00123" });
  assert.equal((await a("admin/logins", "POST", { code: "54321" })).status, 404);
  assert.equal((await a("login-codes", "POST", { code: "54321" })).status, 404);
  db.batch(admin.prepare(db, admin.removeAll()));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM login_codes").first().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").first().count, 0);
  assert.equal((await a("auth")).body.authenticated, false); assert.equal((await b("notes")).status, 401);
  assert.equal((await a("auth", "POST", { code: "12345" })).status, 401);
});

test("revocation during login cannot create a session or log out a different room", async t => {
  const db = setup(t); const a = client(db); await a("auth", "POST", { code: "00123" });
  const batch = db.batch.bind(db); let revoke = true;
  db.batch = statements => {
    if (revoke) { revoke = false; batch(admin.prepare(db, admin.remove("12345"))); }
    return batch(statements);
  };
  assert.equal((await a("auth", "POST", { code: "12345" })).status, 401);
  assert.equal((await a("auth")).body.authenticated, true);
});

test("unissued code guesses are rate limited without creating codes or sessions", async t => {
  const db = setup(t, []); const a = client(db);
  for (let i = 0; i < 10; i++) assert.equal((await a("auth", "POST", { code: "54321" })).status, 401);
  assert.equal((await a("auth", "POST", { code: "54321" })).status, 429);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM login_codes").first().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").first().count, 0);
});
