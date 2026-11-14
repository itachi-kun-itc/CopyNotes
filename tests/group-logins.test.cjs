"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../lib/sqlite-adapter.cjs');
const admin = require('../lib/login-admin.cjs');
const api = import('../lib/cloud-api.mjs');

function setup(t) {
  const db = createDatabase(); t.after(() => db.close());
  for (const code of ['01234', 'G1234', 'G0000']) db.batch(admin.prepare(db, admin.issue(code)));
  return db;
}
function client(db, bearer = false) {
  const cookies = new Map(), states = {};
  return async (path, method = 'GET', body, workspace = 'shared', extra = {}) => {
    const state = states[workspace];
    const response = await (await api).handleApi(new Request('https://copynotes.test/api/' + path, {
      method, headers: { Origin: bearer ? 'https://itachi-kun-itc.github.io' : 'https://copynotes.test',
        'Content-Type': 'application/json', 'X-CopyNotes-Workspace': workspace,
        'X-CopyNotes-Room': state?.roomId || '', Cookie: [...cookies].map(([name, value]) => name + '=' + value).join('; '),
        ...(state?.sessionToken ? { Authorization: 'Bearer ' + state.sessionToken } : {}), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { DB: db });
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (cookie) cookies.set(...cookie.split('='));
    const data = await response.json();
    if (path === 'auth' && method === 'POST' && response.ok) states[data.workspace] = data;
    return { status: response.status, body: data, headers: response.headers };
  };
}
const note = (id, text, baseVersion = 0) => ({ id, text, baseVersion, deleted: false, mutationId: crypto.randomUUID() });
const sync = (...operations) => ({ requestId: crypto.randomUUID(), operations });

test('group numbers are issued only by administrators and retain G plus four digits', t => {
  const db = setup(t);
  assert.equal(admin.issue('G0001').workspace, 'group');
  assert.match(admin.issue(undefined, 'group').code, /^G[0-9]{4}$/);
  assert.equal(db.prepare('SELECT workspace FROM login_codes WHERE code_hash = ?').bind(admin.codeHash('01234')).first().workspace, 'shared');
  assert.equal(db.batch(admin.prepare(db, admin.issue('G1234')))[0].results.length, 0);
  for (const code of ['G123', 'G12345', 'g1234', 'Ｇ1234', 'G１２３４', ' G1234', 'G12a4']) assert.throws(() => admin.issue(code));
  assert.throws(() => admin.issue('12345', 'group'));
  assert.throws(() => admin.issue('G1234', 'shared'));
});

test('three people share group edits, ordering, conflicts and deletion without exposing private or other group notes', async t => {
  const db = setup(t);
  const [a, b, c, other] = Array.from({ length: 4 }, () => client(db));
  await a('auth', 'POST', { code: '01234' });
  await a('notes', 'POST', sync(note('private', 'private note')));
  const login = await a('auth', 'POST', { code: 'G1234' });
  assert.equal(login.body.workspace, 'group');
  assert.match(login.headers.get('set-cookie'), /__Host-cn_group_session=.*HttpOnly; SameSite=Strict/);
  for (const person of [b, c]) assert.equal((await person('auth', 'POST', { code: 'G1234' })).body.roomId, login.body.roomId);
  await other('auth', 'POST', { code: 'G0000' });
  await a('notes', 'POST', sync(note('first', 'group first'), note('second', 'group second')), 'group');
  assert.deepEqual((await b('notes', 'GET', undefined, 'group')).body.notes.map(note => note.text), ['group first', 'group second']);
  assert.deepEqual((await a('notes')).body.notes.map(note => note.text), ['private note']);
  assert.deepEqual((await other('notes', 'GET', undefined, 'group')).body.notes, []);
  await b('note-order', 'POST', { ids: ['second', 'first'], mutationId: crypto.randomUUID() }, 'group');
  assert.deepEqual((await c('notes', 'GET', undefined, 'group')).body.noteOrder.ids, ['second', 'first']);
  await b('notes', 'POST', sync(note('first', 'edited by B', 1)), 'group');
  const conflict = await c('notes', 'POST', sync(note('first', 'stale C edit', 1)), 'group');
  assert.deepEqual(conflict.body.conflicts, ['first']);
  await c('notes', 'POST', sync({ ...note('second', '', 1), deleted: true }), 'group');
  const result = (await a('notes', 'GET', undefined, 'group')).body.notes;
  assert.equal(result.find(note => note.id === 'first').text, 'edited by B');
  assert.equal(result.find(note => note.id === 'second').deleted, true);
  assert.equal((await a('notes', 'GET', undefined, 'group', { 'X-CopyNotes-Room': 'wrong-room' })).status, 401);
});

test('cookie and bearer group sessions coexist with normal logins, logout and revocation remain independent', async t => {
  for (const bearer of [false, true]) {
    const db = setup(t), a = client(db, bearer), b = client(db, bearer);
    const shared = await a('auth', 'POST', { code: '01234' });
    const group = await a('auth', 'POST', { code: 'G1234' });
    await b('auth', 'POST', { code: 'G1234' });
    assert.equal((await a('auth')).body.authenticated, true);
    assert.equal((await a('auth', 'GET', undefined, 'group')).body.authenticated, true);
    assert.equal((await a('notes', 'GET', undefined, 'group', { 'X-CopyNotes-Room': shared.body.roomId })).status, 401);
    if (bearer) {
      assert.equal((await a('notes', 'GET', undefined, 'shared', { Authorization: 'Bearer ' + group.body.sessionToken })).status, 401);
      await a('auth', 'DELETE', undefined, 'shared', { Authorization: 'Bearer ' + group.body.sessionToken });
      assert.equal((await a('auth', 'GET', undefined, 'group')).body.authenticated, true, 'wrong workspace cannot log out the other token');
    }
    assert.equal((await a('auth', 'DELETE', undefined, 'group')).status, 200);
    assert.equal((await a('auth')).body.authenticated, true);
    assert.equal((await a('notes', 'GET', undefined, 'group')).status, 401);
    assert.equal((await b('notes', 'GET', undefined, 'group')).status, 200);
    db.batch(admin.prepare(db, admin.remove('G1234')));
    assert.equal((await b('notes', 'GET', undefined, 'group')).status, 401);
    assert.equal((await a('auth', 'POST', { code: 'G1234' })).status, 401);
    db.batch(admin.prepare(db, admin.issue('G1234')));
    const next = await a('auth', 'POST', { code: 'G1234' });
    assert.notEqual(next.body.roomId, group.body.roomId);
    assert.equal((await a('auth')).body.authenticated, true);
  }
});

test('unissued and malformed group numbers cannot create accounts, and Pages preflights allow workspace selection', async t => {
  const db = setup(t), a = client(db);
  assert.equal((await a('auth', 'POST', { code: 'G9999', create: true })).status, 401);
  for (const code of ['G123', 'G12345', 'g1234', 'G１２３４']) assert.equal((await a('auth', 'POST', { code })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM login_codes').first().count, 3);
  const response = await (await api).handleApi(new Request('https://copynotes.test/api/notes', {
    method: 'OPTIONS', headers: { Origin: 'https://itachi-kun-itc.github.io', 'Access-Control-Request-Method': 'POST' },
  }), { DB: db });
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /X-CopyNotes-Workspace/);
});
