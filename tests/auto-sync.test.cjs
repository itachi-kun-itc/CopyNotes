"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
require("../auto-sync.js");

function setup(run) {
  const jobs = new Map();
  let nextId = 0;
  const state = { enabled: true, ready: true, dirty: true };
  const sync = CopyNotesAutoSync.create({ run,
    enabled: () => state.enabled, ready: () => state.ready, hasChanges: () => state.dirty,
    setTimer(fn, delay) { const id = ++nextId; jobs.set(id, { fn, delay }); return id; },
    clearTimer(id) { jobs.delete(id); },
  });
  function fire() {
    assert.equal(jobs.size, 1);
    const [id, job] = jobs.entries().next().value;
    jobs.delete(id);
    return job.fn();
  }
  return { sync, state, jobs, fire, delay: () => jobs.values().next().value?.delay };
}

test("typing is debounced into one upload, followed by periodic remote refreshes", async () => {
  let calls = 0;
  const h = setup(async () => { calls++; h.state.dirty = false; return true; });
  h.sync.changed(); h.sync.changed(); h.sync.changed();
  assert.equal(h.jobs.size, 1); assert.equal(h.delay(), 800);
  await h.fire();
  assert.equal(calls, 1); assert.equal(h.delay(), 5000);
  await h.fire();
  assert.equal(calls, 2); assert.equal(h.delay(), 5000);
});

test("edits during an upload wait for it to finish and trigger a second upload", async () => {
  let complete;
  let calls = 0;
  const h = setup(() => { calls++; return new Promise(resolve => { complete = resolve; }); });
  h.sync.refresh();
  const first = h.fire();
  h.sync.changed(); h.sync.refresh(); h.sync.changed();
  assert.equal(calls, 1); assert.equal(h.jobs.size, 0);
  complete(true); await first;
  assert.equal(h.delay(), 800);
  const second = h.fire(); assert.equal(calls, 2);
  h.state.dirty = false; complete(true); await second;
  assert.equal(h.delay(), 5000);
});

test("composition, gestures and manual requests defer automatic work", async () => {
  let calls = 0;
  const h = setup(async () => { calls++; return true; });
  h.state.ready = false; h.sync.refresh(); await h.fire();
  assert.equal(calls, 0); assert.equal(h.delay(), 800);
  h.state.ready = true; await h.fire(); assert.equal(calls, 1);
});

test("hidden/offline and logged-out sessions stop requests; resume refreshes immediately", async () => {
  let calls = 0;
  const h = setup(async () => { calls++; return true; });
  h.sync.refresh(); h.sync.pause(); assert.equal(h.jobs.size, 0);
  h.sync.changed(); assert.equal(h.jobs.size, 0);
  h.sync.refresh(); assert.equal(h.delay(), 0);
  h.state.enabled = false; await h.fire();
  assert.equal(calls, 0); assert.equal(h.jobs.size, 0);
  h.sync.changed(); assert.equal(h.jobs.size, 0);
  h.state.enabled = true; h.sync.refresh(); await h.fire(); assert.equal(calls, 1);
});

test("failure retries back off, recover, and stop when a session expires in flight", async () => {
  let fails = true;
  const h = setup(async () => !fails);
  h.sync.refresh();
  for (const expected of [5000, 10000, 20000, 30000, 30000]) { await h.fire(); assert.equal(h.delay(), expected); }
  fails = false; h.state.dirty = false; await h.fire(); assert.equal(h.delay(), 5000);
  const expired = setup(async () => { expired.state.enabled = false; return false; });
  expired.sync.refresh(); await expired.fire(); assert.equal(expired.jobs.size, 0);
});

test("a failed request that throws also retains pending work for retry", async () => {
  const h = setup(async () => { throw new TypeError("offline"); });
  h.sync.refresh(); await h.fire();
  assert.equal(h.state.dirty, true); assert.equal(h.delay(), 5000);
});
