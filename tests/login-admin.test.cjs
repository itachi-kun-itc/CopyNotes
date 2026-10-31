"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { createDatabase } = require("../lib/sqlite-adapter.cjs");
const admin = require("../lib/login-admin.cjs");

test("issuance creates exactly one room, preserves duplicate codes and validates input", t => {
  const db = createDatabase(); t.after(() => db.close());
  const plan = admin.issue("00123"); const created = db.batch(admin.prepare(db, plan));
  assert.equal(created[0].results[0].room_id, plan.roomId);
  assert.deepEqual(db.batch(admin.prepare(db, admin.issue("00123")))[0].results, []);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM login_codes").first().count, 1);
  for (const code of ["1234", "123456", "１２３４５", 12345, "1234'", "     "]) assert.throws(() => admin.issue(code));
  assert.match(admin.issue().code, /^[0-9]{5}$/);
});

test("rendered SQL executes the same bound issuance operation", t => {
  const db = createDatabase(); t.after(() => db.close());
  const plan = admin.issue("00123"); const result = db.prepare(admin.renderSQL(plan)).all();
  assert.equal(result.results[0].room_id, plan.roomId);
  assert.throws(() => admin.remove("1';--"));
});

test("migration removes legacy sessions once and reopening preserves newly issued accounts", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copynotes-migration-test-"));
  const filename = path.join(directory, "test.sqlite");
  t.after(() => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(filename + suffix, { force: true });
    fs.rmdirSync(directory);
  });
  const old = new DatabaseSync(filename);
  old.exec(fs.readFileSync(path.join(__dirname, "../migrations/0001_sharing.sql"), "utf8"));
  old.prepare("INSERT INTO sessions VALUES(?, ?, ?)").run("legacy", "legacy-room", Date.now() + 100000); old.close();
  const db = createDatabase(filename);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions").first().count, 0);
  const plan = admin.issue("00123"); db.batch(admin.prepare(db, plan));
  db.prepare("INSERT INTO sessions VALUES(?, ?, ?)").bind("new-session", plan.roomId, Date.now() + 100000).run(); db.close();
  const reopened = createDatabase(filename);
  try {
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM sessions").first().count, 1);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM login_codes").first().count, 1);
  } finally { reopened.close(); }
});
