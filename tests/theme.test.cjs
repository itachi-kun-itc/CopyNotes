"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../theme.js'), 'utf8');
const key = 'copynotes.settings.v1';
function boot({ disk = new Map(), dark = false, blocked = false } = {}) {
  const root = { dataset: {}, style: {} }, body = { style: {} };
  const meta = { setAttribute(name, value) { this[name] = value; } };
  const attached = [];
  meta.parentNode = { appendChild: node => attached.push(node) };
  const scheme = { setAttribute(name, value) { this[name] = value; } };
  const events = new Map(), documentEvents = new Map(), media = { matches: dark, addEventListener(type, listener) { this.listener = listener; } };
  const document = { documentElement: root, body, visibilityState: 'visible',
    querySelector: selector => selector === 'meta[name="color-scheme"]' ? scheme : meta,
    addEventListener: (type, listener) => documentEvents.set(type, listener) };
  const context = vm.createContext({
    document,
    localStorage: { getItem(name) { if (blocked) throw new Error('SecurityError'); return disk.get(name) ?? null; },
      setItem(name, value) { if (blocked) throw new Error('QuotaExceededError'); disk.set(name, value); } },
    matchMedia: () => media, addEventListener: (type, listener) => events.set(type, listener),
    fetch() { throw new Error('Theme settings must never use the network'); },
  });
  vm.runInContext(source, context);
  return { theme: context.CopyNotesTheme, root, body, document, meta, scheme, disk, media, events, documentEvents, attached };
}

test('theme choices apply immediately and survive reload without changing notes or shared drafts', () => {
  const disk = new Map([['copynotes.notes.v5', '[{"id":"note","text":"keep"}]'], ['copynotes.shared.v4.room', '[]']]);
  const original = [...disk];
  const b = boot({ disk }); assert.equal(b.theme.get(), 'light');
  const colors = { light: '#fafaf9', dark: '#181d21', sepia: '#f4eddf', blue: '#eaf2fa', mint: '#eaf4ee', rose: '#f8edf0', lavender: '#f0edf8', navy: '#121d30' };
  assert.deepEqual(Array.from(b.theme.choices), [...Object.keys(colors), 'system']);
  for (const choice of Object.keys(colors)) {
    assert.equal(b.theme.set(choice), true);
    assert.equal(b.root.dataset.theme, choice);
    assert.equal(b.scheme.content, ['dark', 'navy'].includes(choice) ? 'dark' : 'light');
    assert.equal(b.meta.content, colors[choice]);
    assert.equal(b.root.style.backgroundColor, colors[choice]);
    assert.equal(b.body.style.backgroundColor, colors[choice]);
    const reloaded = boot({ disk });
    assert.equal(reloaded.theme.get(), choice); assert.equal(reloaded.root.dataset.theme, choice);
  }
  assert.equal(b.meta.content, '#121d30');
  assert.deepEqual([...disk].filter(([name]) => name !== key), original);
  assert.equal(boot().theme.get(), 'light', 'another device/browser keeps its own preference');
});

test('native colors reapply after Home Screen resume and after body creation', () => {
  const b = boot(); b.theme.set('navy');
  b.body.style.backgroundColor = '#ffffff'; b.meta.content = '#ffffff';
  b.documentEvents.get('visibilitychange')();
  assert.equal(b.body.style.backgroundColor, '#121d30'); assert.equal(b.meta.content, '#121d30');
  b.root.style.backgroundColor = '#ffffff'; b.events.get('pageshow')();
  assert.equal(b.root.style.backgroundColor, '#121d30');
  b.document.body = null; b.theme.set('mint');
  b.document.body = { style: {} }; b.documentEvents.get('DOMContentLoaded')();
  assert.equal(b.document.body.style.backgroundColor, '#eaf4ee');
  assert.ok(b.attached.every(node => node === b.meta));
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
