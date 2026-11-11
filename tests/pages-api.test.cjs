"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDatabase } = require("../lib/sqlite-adapter.cjs");
const admin = require("../lib/login-admin.cjs");
const api = import("../lib/cloud-api.mjs");
const origin = "https://itachi-kun-itc.github.io";
function setup(t) {
  const db = createDatabase(); t.after(() => db.close());
  db.batch(admin.prepare(db, admin.issue("00123")));
  return db;
}
async function send(db, path = "auth", method = "GET", body, headers = {}) {
  const { handleApi } = await api;
  const response = await handleApi(new Request(`https://copynotes.test/api/${path}`, {
    method, headers: { Origin: origin, "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { DB: db });
  return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
}

test("CORS permits the exact GitHub Pages origin and rejects other origins", async t => {
  const db = setup(t);
  const allowed = await send(db, "auth", "OPTIONS", undefined, { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization,x-copynotes-room" });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), origin);
  assert.match(allowed.headers.get("access-control-allow-headers"), /Authorization/);
  assert.match(allowed.headers.get("access-control-allow-headers"), /X-CopyNotes-Room/);
  assert.equal(allowed.headers.get("access-control-allow-credentials"), null);
  assert.equal(allowed.headers.get("vary"), "Origin");
  for (const candidate of ["https://other.github.io", origin + ".example.com", "http://itachi-kun-itc.github.io", 'http://localhost:5501', 'http://localhost.example.com:5500', 'http://127.0.0.1.example.com:5500', 'http://192.168.1.1:5500', 'null']) {
    const denied = await send(db, "auth", "POST", { code: "00123" }, { Origin: candidate });
    assert.equal(denied.status, 403); assert.equal(denied.headers.get("access-control-allow-origin"), null);
  }
});

test('loopback port 5500 supports preflight, login, synchronization and logout with memory-only bearer sessions', async t => {
  const db = setup(t);
  for (const preview of ['http://localhost:5500', 'http://127.0.0.1:5500', 'http://[::1]:5500']) {
    const preflight = await send(db, 'auth', 'OPTIONS', undefined, { Origin: preview, 'Access-Control-Request-Method': 'POST' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), preview);
    assert.equal(preflight.headers.has('access-control-allow-credentials'), false);
    const login = await send(db, 'auth', 'POST', { code: '00123' }, { Origin: preview });
    assert.equal(login.status, 200); assert.equal(login.body.expiresIn, 900);
    assert.match(login.body.sessionToken, /^[a-f0-9]{64}$/);
    assert.equal(login.headers.get('access-control-allow-origin'), preview);
    assert.equal(login.headers.has('set-cookie'), false);
    const headers = { Origin: preview, Authorization: 'Bearer ' + login.body.sessionToken, 'X-CopyNotes-Room': login.body.roomId };
    assert.equal((await send(db, 'auth', 'GET', undefined, headers)).body.authenticated, true);
    const id = crypto.randomUUID();
    const note = { id, text: 'from local preview', baseVersion: 0, deleted: false, mutationId: crypto.randomUUID() };
    const saved = await send(db, 'notes', 'POST', { requestId: crypto.randomUUID(), operations: [note] }, headers);
    assert.equal(saved.status, 200); assert.equal(saved.body.notes.find(value => value.id === id).text, note.text);
    assert.equal((await send(db, 'notes', 'GET', undefined, headers)).status, 200);
    assert.equal((await send(db, 'images/' + crypto.randomUUID(), 'GET', undefined, headers)).status, 404);
    const logout = await send(db, 'auth', 'DELETE', undefined, headers);
    assert.equal(logout.status, 200); assert.equal(logout.headers.has('set-cookie'), false);
    assert.equal((await send(db, 'notes', 'GET', undefined, headers)).status, 401);
    const invalid = await send(db, 'auth', 'POST', { code: '12345' }, { Origin: preview });
    assert.equal(invalid.status, 401); assert.equal(invalid.headers.get('access-control-allow-origin'), preview);
  }
});

test("Pages issues a 15-minute in-memory session and no cross-site cookie", async t => {
  const db = setup(t); const before = Date.now();
  const login = await send(db, "auth", "POST", { code: "00123" });
  assert.equal(login.status, 200); assert.match(login.body.sessionToken, /^[a-f0-9]{64}$/);
  assert.equal(login.body.expiresIn, 900); assert.equal(login.headers.has("set-cookie"), false);
  const session = db.prepare("SELECT expires_at FROM sessions").first();
  assert.ok(session.expires_at >= before + 900000 && session.expires_at <= Date.now() + 900000);
  const headers = { Authorization: `Bearer ${login.body.sessionToken}`, 'X-CopyNotes-Room': login.body.roomId };
  assert.equal((await send(db, "auth", "GET", undefined, headers)).body.authenticated, true);
  assert.equal((await send(db, "notes", "GET", undefined, headers)).status, 200);
  assert.equal((await send(db, "notes")).status, 401);
  const logout = await send(db, "auth", "DELETE", undefined, headers);
  assert.equal(logout.status, 200); assert.equal(logout.headers.has("set-cookie"), false);
  assert.equal((await send(db, "notes", "GET", undefined, headers)).status, 401);
});

test("native Cloudflare login keeps HttpOnly cookies and never returns a readable token", async t => {
  const db = setup(t);
  const login = await send(db, "auth", "POST", { code: "00123" }, { Origin: "https://copynotes.test", "Sec-Fetch-Site": "same-origin" });
  assert.equal(login.status, 200); assert.equal(login.body.sessionToken, undefined);
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await send(db, "auth", "GET", undefined, { Origin: "https://copynotes.test", "Sec-Fetch-Site": "same-origin", Cookie: cookie })).body.authenticated, true);
  assert.equal((await send(db, "auth", "GET", undefined, { Origin: "https://copynotes.test", "Sec-Fetch-Site": "same-origin", Cookie: cookie, Authorization: "Bearer invalid" })).body.authenticated, false);
});

test("Pages and native sessions access the same room; expiry and revocation reject both", async t => {
  const db = setup(t);
  const first = await send(db, "auth", "POST", { code: "00123" });
  const second = await send(db, "auth", "POST", { code: "00123" });
  assert.equal(first.body.roomId, second.body.roomId);
  const headers = { Authorization: `Bearer ${first.body.sessionToken}`, 'X-CopyNotes-Room': first.body.roomId };
  const operation = { id: "shared", text: "shared across hosts", mutationId: crypto.randomUUID(), baseVersion: 0, deleted: false };
  assert.equal((await send(db, "notes", "POST", { requestId: crypto.randomUUID(), operations: [operation] }, headers)).status, 200);
  const data = await send(db, "notes", "GET", undefined, { Authorization: `Bearer ${second.body.sessionToken}`, 'X-CopyNotes-Room': second.body.roomId });
  assert.equal(data.body.notes[0].text, operation.text);
  db.batch(admin.prepare(db, admin.remove("00123")));
  assert.equal((await send(db, "notes", "GET", undefined, headers)).status, 401);
  assert.equal((await send(db, "auth", "POST", { code: "00123" })).status, 401);
});

test("Pages errors include CORS but unknown codes still cannot register", async t => {
  const db = setup(t);
  const response = await send(db, "auth", "POST", { code: "99999", create: true });
  assert.equal(response.status, 401); assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM login_codes").first().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").first().count, 0);
});
