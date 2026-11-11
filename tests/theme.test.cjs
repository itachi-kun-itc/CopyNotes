"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../theme.js'), 'utf8');
const key = 'copynotes.settings.v1';
function boot({ disk = new Map(), dark = false, blocked = false } = {}) {
  const root = { dataset: {} }, meta = { setAttribute(name, value) { this[name] = value; } };
  const scheme = { setAttribute(name, value) { this[name] = value; } };
  const events = new Map(), media = { matches: dark, addEventListener(type, listener) { this.listener = listener; } };
  const context = vm.createContext({
    document: { documentElement: root, querySelector: selector => selector === 'meta[name="color-scheme"]' ? scheme : meta },
    localStorage: { getItem(name) { if (blocked) throw new Error('SecurityError'); return disk.get(name) ?? null; },
      setItem(name, value) { if (blocked) throw new Error('QuotaExceededError'); disk.set(name, value); } },
    matchMedia: () => media, addEventListener: (type, listener) => events.set(type, listener),
    fetch() { throw new Error('Theme settings must never use the network'); },
  });
  vm.runInContext(source, context);
  return { theme: context.CopyNotesTheme, root, meta, scheme, disk, media, events };
}

test('theme choices apply immediately and survive reload without changing notes or shared drafts', () => {
  const disk = new Map([['copynotes.notes.v5', '[{"id":"note","text":"keep"}]'], ['copynotes.shared.v4.room', '[]']]);
  const original = [...disk];
  const b = boot({ disk }); assert.equal(b.theme.get(), 'light');
  for (const choice of ['light', 'dark', 'sepia']) {
    assert.equal(b.theme.set(choice), true);
    assert.equal(b.root.dataset.theme, choice);
    assert.equal(b.scheme.content, choice === 'dark' ? 'dark' : 'light');
    const reloaded = boot({ disk });
    assert.equal(reloaded.theme.get(), choice); assert.equal(reloaded.root.dataset.theme, choice);
  }
  assert.equal(b.meta.content, '#f4eddf');
  assert.deepEqual([...disk].filter(([name]) => name !== key), original);
  assert.equal(boot().theme.get(), 'light', 'another device/browser keeps its own preference');
});

test('system choice follows OS changes while explicit choices remain fixed', () => {
  const b = boot({ dark: true });
  b.theme.set('system'); assert.equal(b.root.dataset.theme, 'dark');
  assert.equal(b.scheme.content, 'dark');
  b.media.matches = false; b.media.listener(); assert.equal(b.root.dataset.theme, 'light');
  assert.equal(b.scheme.content, 'light');
  assert.equal(JSON.parse(b.disk.get(key)).theme, 'system');
  b.theme.set('sepia'); b.media.matches = true; b.media.listener();
  assert.equal(b.root.dataset.theme, 'sepia');
});

test('unavailable storage still permits changing the current session theme', () => {
  const b = boot({ blocked: true });
  assert.equal(b.theme.get(), 'light');
  assert.equal(b.theme.set('dark'), false);
  assert.equal(b.root.dataset.theme, 'dark'); assert.equal(b.theme.get(), 'dark');
});

test('invalid preferences fall back to light and unrelated storage events cannot change the theme', () => {
  for (const value of ['broken', 'null', '{}', '{"theme":"unknown"}']) assert.equal(boot({ disk: new Map([[key, value]]) }).theme.get(), 'light');
  const b = boot(), changes = [];
  const stop = b.theme.subscribe(value => changes.push(value));
  const receive = b.events.get('storage');
  receive({ key: 'copynotes.shared.v4.room', newValue: '{"theme":"dark"}' });
  assert.equal(b.theme.get(), 'light'); assert.equal(changes.length, 0);
  receive({ key, newValue: '{"theme":"dark"}' });
  assert.equal(b.root.dataset.theme, 'dark'); assert.deepEqual(changes, ['dark']);
  assert.equal(b.disk.has(key), false, 'storage events do not echo writes');
  receive({ key, newValue: null }); assert.equal(b.theme.get(), 'light');
  stop(); b.theme.set('sepia'); assert.deepEqual(changes, ['dark', 'light']);
});
