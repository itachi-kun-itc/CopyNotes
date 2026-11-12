"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A small DOM adapter runs the real app's event handlers without a browser or dependencies.
class Element {
  constructor(tag = 'div', className = '') {
    Object.assign(this, { tagName: tag, className, children: [], dataset: {}, style: {}, attributes: {}, listeners: {}, value: '', files: [], scrollTop: 0 });
    this.style.setProperty = (name, value) => { this.style[name] = value; };
    this.style.removeProperty = name => { delete this.style[name]; };
    this.classList = { contains: name => this.className.split(' ').includes(name),
      add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; },
      remove: name => { this.className = this.className.split(' ').filter(item => item !== name).join(' '); },
      toggle: (name, enabled) => { enabled ? this.classList.add(name) : this.classList.remove(name); } };
  }
  addEventListener(type, callback, options) { (this.listeners[type] ||= []).push({ callback, capture: Boolean(options === true || options?.capture) }); }
  dispatchEvent(event) {
    event.target = this; event.preventDefault = () => { event.defaultPrevented = true; };
    event.stopImmediatePropagation = () => { event.stopped = true; };
    const nodes = []; for (let node = this; node; node = node.parentElement) nodes.push(node);
    for (const capture of [true, false]) for (const node of capture ? [...nodes].reverse() : nodes) {
      for (const listener of node.listeners[event.type] || []) {
        if (listener.capture === capture) listener.callback(event);
        if (event.stopped) return false;
      }
    }
    return !event.defaultPrevented;
  }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; node.ownerDocument = this.ownerDocument; this.children.push(node); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parentElement = null; }); this.children = []; this.append(...nodes); }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    if (selector === 'a[href]') return this.tagName === 'a' && 'href' in this.attributes;
    if (selector === '[tabindex]') return 'tabindex' in this.attributes;
    if (selector.includes(':not(')) return this.matches(selector.split(':')[0]) && !this.classList.contains('is-removing');
    return selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : selector.startsWith('#') ? this.id === selector.slice(1) : this.tagName === selector;
  }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  getClientRects() { return []; }
  getAnimations() { return []; }
  show() { this.open = true; (this.attributes.autofocus !== undefined ? this : this.querySelector('button') || this).focus(); }
  showModal() { throw new Error('Native modal compositor must not be used'); }
  close() { const wasOpen = this.open; this.open = false; if (wasOpen) this.dispatchEvent({ type: 'close' }); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 360, bottom: 300 }; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  get isConnected() { return this.connected || Boolean(this.parentElement?.isConnected); }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
}

function boot({ clipboard = true, formats = ['image/png', 'text/plain'], indexedDB, authenticated = false, savedDisk,
  origin = 'http://localhost', sessionDisk = new Map(), apiFetch, config, layout = { top: '32px', inset: '0px' } } = {}) {
  const document = new Element('document'); document.connected = true; document.ownerDocument = document;
  document.visibilityState = 'hidden'; document.baseURI = origin + '/'; document.body = document; document.documentElement = document;
  document.createElement = tag => { const element = new Element(tag); element.ownerDocument = document; return element; };
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const nodes = new Map();
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = document.createElement(match[1]); element.id = match[2]; nodes.set('#' + element.id, element); document.append(element);
    if (/\bautofocus(?:\s|=|>)/.test(match[0])) element.setAttribute('autofocus', '');
  }
  for (const name of ['notes', 'notes-scroll', 'workspace-tabs', 'system-bar-background']) { const element = document.createElement('div'); element.className = name; nodes.set('.' + name, element); document.append(element); }
  document.querySelector = selector => nodes.get(selector) || null;
  nodes.get('#noteTemplate').content = { firstElementChild: { cloneNode() {
    const row = document.createElement('div'); row.className = 'note-row';
    for (const [tag, className] of [['pre', 'note-highlight'], ['textarea', 'note-input'], ['button', 'copy-button'], ['button', 'download-button'], ['div', 'note-images'], ['span', 'image-count'], ['button', 'attach-image'], ['input', 'image-input']]) {
      const child = document.createElement(tag); child.className = className; row.append(child);
    }
    return row;
  } } };
  const disk = savedDisk || new Map(), downloads = [], copiedImages = [], requests = [], frames = [];
  let selectTab, runAutoSync;
  const context = vm.createContext({ document, window: new Element('window'), crypto, URL, Blob, atob, Uint8Array, TextEncoder,
    navigator: { onLine: true, clipboard: clipboard ? { write: async () => {} } : undefined }, location: { origin },
    ClipboardItem: class { constructor(data) { this.data = data; } static supports(type) { return formats.includes(type); } },
    indexedDB,
    localStorage: { get length() { return disk.size; }, key: index => [...disk.keys()][index], getItem: key => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, value) },
    sessionStorage: { getItem: key => sessionDisk.get(key) ?? null, setItem: (key, value) => sessionDisk.set(key, value), removeItem: key => sessionDisk.delete(key) },
    setTimeout: (callback, delay) => { if (!delay) queueMicrotask(callback); return 1; }, clearTimeout() {}, requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    getComputedStyle: element => ({
      paddingTop: document.style['--overlay-notes-top'] ?? layout.top,
      height: document.style['--overlay-inset-top'] ?? Math.max(16, parseFloat(layout.inset)) + 'px',
    }),
    AbortController, fetch: async (url, options) => { requests.push({ url, options });
      if (apiFetch) return apiFetch(url, options);
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => String(url).endsWith('/notes') ? { notes: [] } : { authenticated, roomId: authenticated ? 'room' : null } }; },
    CopyNotesTouch: { attach: () => ({ cancel() {}, active: false }) },
    CopyNotesAutoSync: { create: options => { runAutoSync = options.run; return { changed() {}, refresh() {}, pause() {} }; } },
    CopyNotesTabs: { attach: (element, options) => { selectTab = options.onChange; return { sync() {} }; } },
    CopyNotesSyntax: { detect: () => null, tokenize: () => [] },
    CopyNotesLinks: { find: () => [], render: () => document.createElement('span') },
    CopyNotesLimits: { attach() {} }, CopyNotesEditor: { attach() {} },
  });
  for (const file of ['app-config.js', 'theme.js', 'note-images.js', 'attachment-storage.js', 'image-transfer.js', 'sharing.js', 'device-storage.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  if (config) context.CopyNotesConfig = config;
  context.CopyNotesImages = { ...context.CopyNotesImages, prepare: async file => file.src, copy: async (text, sources) => copiedImages.push([...sources]), download: async sources => downloads.push([...sources]) };
  const ready = vm.runInContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context);
  const list = nodes.get('#noteList');
  return { ready, tab: index => selectTab(index), runAutoSync: () => runAutoSync(), row: () => list.children[0], add: () => nodes.get('#addNote').click(), list, disk, sessionDisk, downloads, copiedImages, context, requests,
    flushFrames: () => { for (const callback of frames.splice(0)) callback(); } };
}

const photo = { type: 'image/png', src: 'data:image/png;base64,aGVsbG8=' };
function paste(row, files) { row.querySelector('textarea').dispatchEvent({ type: 'paste', clipboardData: { files } }); }

test('app refuses images in text notes and limits images to one across overlapping paste events', async () => {
  const app = boot(); const textRow = app.row(), text = textRow.querySelector('textarea');
  text.value = 'keep my text'; text.dispatchEvent({ type: 'input' });
  assert.equal(textRow.querySelector('.attach-image').disabled, true); paste(textRow, [photo]);
  assert.equal(text.value, 'keep my text'); assert.equal(textRow.noteImages.length, 0);
  app.add(); const imageRow = app.list.children[1];
  paste(imageRow, [photo, photo]); paste(imageRow, [photo]); await imageRow.attachmentQueue;
  assert.equal(imageRow.noteImages.length, 1); assert.equal(imageRow.querySelector('.image-count').textContent, '1/1');
  assert.equal(imageRow.querySelector('.attach-image').disabled, true);
  assert.equal(imageRow.querySelector('textarea').readOnly, true);
  const input = imageRow.querySelector('textarea'); input.value = 'must not coexist'; input.dispatchEvent({ type: 'input' });
  assert.equal(input.value, '');
  const saved = JSON.parse(app.disk.get(app.context.CopyNotesDeviceStorage.key));
  assert.equal(saved[1].text, ''); assert.deepEqual(saved[1].images, [photo.src]);
});

test('empty and text memos hide download, and image decoding errors release the editor', async () => {
  const app = boot(); const row = app.row();
  assert.equal(row.querySelector('.download-button').hidden, true);
  assert.equal(row.querySelector('.copy-button').disabled, true);
  app.context.CopyNotesImages.prepare = async () => { throw new Error('invalid image'); };
  paste(row, [photo]);
  assert.equal(row.querySelector('textarea').readOnly, true);
  await row.attachmentQueue;
  assert.equal(row.noteImages.length, 0);
  assert.equal(row.querySelector('textarea').readOnly, false);
  assert.equal(row.querySelector('.attach-image').disabled, false);
  const input = row.querySelector('textarea'); input.value = 'text'; input.dispatchEvent({ type: 'input' });
  assert.equal(row.querySelector('.copy-button').disabled, false);
  assert.equal(row.querySelector('.download-button').hidden, true);
});

test('image notes have independent copy and download actions; unsupported clipboard disables copy without disabling download', async () => {
  for (const clipboard of [true, false]) {
    const app = boot({ clipboard }); const row = app.row();
    row.querySelector('textarea').focus();
    paste(row, [photo, photo]); await row.attachmentQueue;
    assert.equal(row.ownerDocument.activeElement, row.querySelector(clipboard ? '.copy-button' : '.download-button'));
    assert.equal(row.classList.contains('has-attachment'), true);
    assert.equal(row.querySelector('.copy-button').disabled, !clipboard);
    assert.equal(row.querySelector('.download-button').hidden, false);
    assert.equal(row.querySelector('.download-button').disabled, false);
    row.querySelector('.copy-button').click(); await new Promise(setImmediate);
    assert.equal(app.copiedImages.length, clipboard ? 1 : 0);
    row.querySelector('.download-button').click(); await new Promise(setImmediate);
    assert.deepEqual(app.downloads[0], [photo.src]);
    assert.equal(row.noteImages.length, 1);
  }
});

test('device and shared tabs each accept three image memos and reject a fourth, including overlapping pastes', async () => {
  const app = boot({ authenticated: true }); await app.ready; await new Promise(setImmediate);
  for (const tab of [0, 1]) {
    app.tab(tab);
    while (app.list.children.length < 4) app.add();
    const rows = [...app.list.children];
    for (const row of rows) paste(row, [photo]);
    await Promise.all(rows.map(row => row.attachmentQueue));
    assert.equal(app.list.children.filter(row => row.noteImages.length).length, 3);
    assert.equal(rows[3].noteImages.length, 0);
    assert.equal(rows[3].querySelector('.attach-image').disabled, true);
    paste(rows[3], [photo]);
    assert.match(app.context.document.querySelector('#status').textContent, /3枚/);
    // Deleting one image memo releases a slot for the empty memo.
    rows[0].remove();
    const input = rows[3].querySelector('textarea'); input.dispatchEvent({ type: 'input' });
    assert.equal(rows[3].querySelector('.attach-image').disabled, false);
    paste(rows[3], [photo]); await rows[3].attachmentQueue;
    assert.equal(rows[3].noteImages.length, 1);
  }
});

test('a full-size attachment is durable before it appears and reloads with the same data', async () => {
  const { IDBFactory } = require('fake-indexeddb');
  const indexedDB = new IDBFactory();
  const src = 'data:image/png;base64,' + Buffer.alloc(20 * 1024 * 1024, 123).toString('base64');
  const app = boot({ indexedDB }); await app.ready;
  const row = app.row();
  paste(row, [{ type: 'image/png', src }]); await row.attachmentQueue;
  assert.equal(row.noteImages[0], src);
  assert.ok(app.disk.get(app.context.CopyNotesDeviceStorage.key).length < 300);
  const reloaded = boot({ indexedDB, savedDisk: app.disk }); await reloaded.ready;
  assert.equal(reloaded.row().noteImages[0], src);
});

test('settings replace notices, persist themes locally and never send a shared update', async () => {
  const app = boot({ authenticated: true }); await app.ready; await new Promise(setImmediate);
  const document = app.context.document;
  assert.equal(document.querySelector('#noticeButton'), null);
  assert.equal(document.querySelector('#settingsScope'), null);
  assert.equal(document.querySelector('#settingsStatus'), null);
  document.querySelector('#settingsButton').click();
  assert.equal(document.querySelector('#settingsDialog').open, true);
  const before = app.requests.length;
  const beforeStatus = document.querySelector('#status').textContent;
  const field = document.querySelector('#colorTheme'); field.value = 'dark'; field.dispatchEvent({ type: 'change' });
  await new Promise(setImmediate);
  assert.equal(document.dataset.theme, 'dark');
  assert.equal(app.requests.length, before);
  assert.equal(document.querySelector('#status').textContent, beforeStatus, 'successful theme changes are silent');
  assert.equal(JSON.parse(app.disk.get('copynotes.settings.v1')).theme, 'dark');
  assert.equal(app.disk.get('copynotes.shared.v4.room').includes('theme'), false);
  app.tab(1); app.tab(0); assert.equal(field.value, 'dark');
  document.querySelector('#closeSettings').click(); assert.equal(document.querySelector('#settingsDialog').open, false);
  document.querySelector('#settingsButton').click();
  document.querySelector('#modalBackdrop').click();
  assert.equal(document.querySelector('#settingsDialog').open, false);
  const reloaded = boot({ savedDisk: app.disk }); await reloaded.ready;
  assert.equal(reloaded.context.document.dataset.theme, 'dark');
  assert.equal(reloaded.context.document.querySelector('#colorTheme').value, 'dark');
  const otherDevice = boot({ authenticated: true }); await otherDevice.ready;
  assert.equal(otherDevice.context.document.dataset.theme, 'light');
});

test('refresh stays disabled on the device tab and is available only for authenticated shared notes', async () => {
  for (const authenticated of [false, true]) {
    const app = boot({ authenticated }); await app.ready; await new Promise(setImmediate);
    const button = app.context.document.querySelector('#refreshNotes');
    assert.equal(button.disabled, true);
    const count = app.requests.length; button.click(); await new Promise(setImmediate);
    assert.equal(app.requests.length, count);
    app.tab(1); assert.equal(button.disabled, !authenticated);
    app.tab(0); assert.equal(button.disabled, true);
  }
});

test('manual refresh, sync and background polling keep temporary locks distinct from unavailable toolbar actions', async () => {
  let pending, finish;
  const app = boot({ authenticated: true, apiFetch: url => String(url).endsWith('/auth')
    ? Response.json({ authenticated: true, roomId: 'room' }) : pending || Response.json({ notes: [] }) });
  await settled(app);
  const document = app.context.document;
  app.tab(1);
  for (const action of ['#refreshNotes', '#syncNotes', 'automatic']) {
    pending = new Promise(resolve => { finish = resolve; });
    const before = app.requests.length;
    const operation = action === 'automatic' ? app.runAutoSync() : document.querySelector(action).click();
    await until(() => app.requests.length > before);
    for (const id of ['#accountButton', '#refreshNotes', '#syncNotes']) {
      const button = document.querySelector(id);
      assert.equal(button.disabled, true, `${action}: duplicate actions remain blocked`);
      assert.equal(button.attributes['aria-busy'], 'true', `${action}: the busy style preserves the available appearance`);
      button.click();
    }
    await new Promise(setImmediate);
    assert.equal(app.requests.length, before + 1);
    finish(Response.json({ notes: [] })); await operation;
    await until(() => !document.querySelector('#accountButton').disabled);
    for (const id of ['#accountButton', '#refreshNotes', '#syncNotes']) {
      assert.equal(document.querySelector(id).disabled, false);
      assert.equal(document.querySelector(id).attributes['aria-busy'], 'false');
    }
    pending = null;
  }
  app.tab(0);
  pending = new Promise(resolve => { finish = resolve; });
  const operation = app.runAutoSync();
  for (const id of ['#refreshNotes', '#syncNotes']) {
    assert.equal(document.querySelector(id).disabled, true);
    assert.equal(document.querySelector(id).attributes['aria-busy'], 'false', 'device actions stay unavailable during background work');
  }
  assert.equal(document.querySelector('#accountButton').attributes['aria-busy'], 'true');
  finish(Response.json({ notes: [] })); await operation;
});

test('expired authentication clears busy styling and leaves shared actions unavailable', async () => {
  let pending, finish;
  const app = boot({ authenticated: true, apiFetch: url => String(url).endsWith('/auth')
    ? Response.json({ authenticated: true, roomId: 'room' }) : pending || Response.json({ notes: [] }) });
  await settled(app); app.tab(1);
  pending = new Promise(resolve => { finish = resolve; });
  const operation = app.runAutoSync();
  finish(Response.json({ error: 'expired' }, { status: 401 })); await operation;
  const document = app.context.document;
  assert.equal(document.querySelector('#accountButton').disabled, false);
  assert.equal(document.querySelector('#accountButton').textContent, 'ログイン');
  for (const id of ['#accountButton', '#refreshNotes', '#syncNotes']) assert.equal(document.querySelector(id).attributes['aria-busy'], 'false');
  for (const id of ['#refreshNotes', '#syncNotes']) assert.equal(document.querySelector(id).disabled, true);
});

test('theme input repaints the top edge before settings closes or selection change is committed', async () => {
  const app = boot(); await app.ready;
  const document = app.context.document;
  document.querySelector('#settingsButton').click();
  const field = document.querySelector('#colorTheme'); field.value = 'rose';
  field.dispatchEvent({ type: 'input' });
  assert.equal(document.querySelector('#settingsDialog').open, true);
  assert.equal(document.dataset.theme, 'rose');
  assert.equal(document.querySelector('.system-bar-background').style.backgroundColor, '#f8edf0');
  assert.equal(JSON.parse(app.disk.get('copynotes.settings.v1')).theme, 'rose');
  field.dispatchEvent({ type: 'change' });
  assert.equal(document.querySelector('#settingsDialog').open, true);
  assert.equal(document.querySelector('.system-bar-background').style.backgroundColor, '#f8edf0');
});

test('settings and account overlays preserve header spacing if iOS reduces its safe area', async () => {
  for (const trigger of ['#settingsButton', '#accountButton']) {
    const layout = { top: '59px', inset: '59px' };
    const app = boot({ layout }); await app.ready; await new Promise(setImmediate);
    const document = app.context.document;
    document.querySelector(trigger).click();
    assert.equal(document.style['--overlay-notes-top'], '59px');
    assert.equal(document.style['--overlay-inset-top'], '59px');
    layout.top = '20px'; layout.inset = '0px';
    assert.equal(app.context.getComputedStyle(document.querySelector('.notes')).paddingTop, '59px');
    assert.equal(app.context.getComputedStyle(document.querySelector('.system-bar-background')).height, '59px');
    if (trigger === '#settingsButton') {
      const field = document.querySelector('#colorTheme'); field.value = 'navy'; field.dispatchEvent({ type: 'change' });
      assert.equal(document.style['--overlay-notes-top'], '59px');
      assert.equal(document.dataset.theme, 'navy');
    }
    // The page handles Escape without entering the native modal compositor.
    const dialog = document.querySelector(trigger === '#settingsButton' ? '#settingsDialog' : '#loginDialog');
    document.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(dialog.open, false);
    assert.equal(document.style['--overlay-notes-top'], '59px', 'release waits for the next layout frame');
    layout.top = '59px'; layout.inset = '59px'; app.flushFrames();
    assert.equal(document.style['--overlay-notes-top'], undefined);
    assert.equal(document.style['--overlay-inset-top'], undefined);
    assert.equal(app.context.getComputedStyle(document.querySelector('.notes')).paddingTop, '59px');
  }
});

test('settings, login and logout retain normal-page top spacing when the safe area grows', async () => {
  for (const authenticated of [false, true]) for (const trigger of ['#settingsButton', '#accountButton']) {
    const layout = { top: '20px', inset: '0px' };
    const app = boot({ layout, authenticated }); await settled(app);
    const document = app.context.document;
    document.querySelector(trigger).click();
    const notes = document.querySelector('.notes'), edge = document.querySelector('.system-bar-background');
    assert.equal(document.style['--overlay-notes-top'], '20px');
    assert.equal(document.style['--overlay-inset-top'], '16px');
    layout.top = '59px'; layout.inset = '59px';
    assert.equal(app.context.getComputedStyle(notes).paddingTop, '20px');
    assert.equal(app.context.getComputedStyle(edge).height, '16px');
    if (trigger === '#settingsButton') {
      const field = document.querySelector('#colorTheme'); field.value = 'mint'; field.dispatchEvent({ type: 'input' });
      assert.equal(edge.style.backgroundColor, '#eaf4ee');
      assert.equal(document.style.backgroundColor, '#eaf4ee');
      assert.equal(app.context.getComputedStyle(notes).paddingTop, '20px');
      assert.equal(app.context.getComputedStyle(edge).height, '16px');
    }
    document.dispatchEvent({ type: 'keydown', key: 'Escape' });
    layout.top = '20px'; layout.inset = '0px'; app.flushFrames();
    assert.equal(app.context.getComputedStyle(notes).paddingTop, '20px');
    assert.equal(app.context.getComputedStyle(edge).height, '16px');
    assert.equal(document.style['--overlay-notes-top'], undefined);
  }
});

test('closing one overlay cannot release another overlay spacing, including a failed open', async () => {
  const app = boot({ layout: { top: '59px', inset: '59px' } }); await app.ready; await new Promise(setImmediate);
  const document = app.context.document;
  document.querySelector('#settingsButton').click();
  document.querySelector('#closeSettings').click();
  document.querySelector('#accountButton').click(); app.flushFrames();
  assert.equal(document.style['--overlay-notes-top'], '59px');
  document.querySelector('#loginDialog').close(); app.flushFrames();
  assert.equal(document.style['--overlay-notes-top'], undefined);
  document.querySelector('#settingsDialog').show = () => { throw new Error('cannot open'); };
  assert.throws(() => document.querySelector('#settingsButton').click(), /cannot open/);
  assert.equal(document.style['--overlay-notes-top'], undefined);
  assert.equal(document.style['--overlay-inset-top'], undefined);
  assert.equal(document.querySelector('#modalBackdrop').hidden, true);
  assert.equal(document.querySelector('.notes').inert, false);
});

test('page overlays trap focus, block background interaction and restore the opener without a native modal', async () => {
  const app = boot(); await app.ready; await new Promise(setImmediate);
  const document = app.context.document;
  const trigger = document.querySelector('#settingsButton'), dialog = document.querySelector('#settingsDialog');
  const close = document.querySelector('#closeSettings'), select = document.querySelector('#colorTheme');
  dialog.append(close, select);
  close.getClientRects = select.getClientRects = () => [{}];
  trigger.focus(); trigger.click();
  assert.equal(dialog.open, true);
  assert.equal(document.querySelector('#modalBackdrop').hidden, false);
  assert.equal(document.querySelector('.notes').inert, true);
  assert.equal(document.querySelector('#noteMenu').inert, true);
  assert.equal(document.documentElement.dataset.overlayOpen, 'true');
  assert.equal(document.activeElement, document.body);
  document.dispatchEvent({ type: 'keydown', key: 'Tab' }); assert.equal(document.activeElement, close);
  document.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: true }); assert.equal(document.activeElement, select);
  document.dispatchEvent({ type: 'keydown', key: 'Tab' }); assert.equal(document.activeElement, close);
  select.value = 'mint'; select.dispatchEvent({ type: 'input' });
  assert.equal(document.querySelector('.system-bar-background').style.backgroundColor, '#eaf4ee');
  assert.equal(dialog.open, true);
  document.dispatchEvent({ type: 'keydown', key: 'Escape' }); app.flushFrames();
  assert.equal(dialog.open, false);
  assert.equal(document.querySelector('#modalBackdrop').hidden, true);
  assert.equal(document.querySelector('.notes').inert, false);
  assert.equal(document.querySelector('#noteMenu').inert, false);
  assert.equal(document.documentElement.dataset.overlayOpen, undefined);
  assert.equal(document.activeElement, trigger);
});

test('opening settings, login and logout never leaves a control focused', async () => {
  for (const authenticated of [false, true]) {
    const app = boot({ authenticated }); await app.ready; await new Promise(setImmediate);
    const document = app.context.document;
    for (const [triggerId, dialogId] of [['#settingsButton', '#settingsDialog'], ['#accountButton', '#loginDialog']]) {
      const trigger = document.querySelector(triggerId); trigger.focus(); trigger.click();
      assert.equal(document.querySelector(dialogId).open, true);
      assert.equal(document.activeElement, document.body);
      for (const id of ['#closeSettings', '#closeLogin', '#loginNumber', '#logoutButton']) assert.notEqual(document.activeElement, document.querySelector(id));
      document.querySelector(dialogId).close(); app.flushFrames();
    }
  }
});

test('Escape cannot dismiss an account overlay while authentication is in flight', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = boot({ apiFetch: (url, options) => options.method === 'POST' ? pending : Response.json({ authenticated: false }) });
  await settled(app);
  const document = app.context.document;
  document.querySelector('#accountButton').click();
  document.querySelector('#loginNumber').value = '00123';
  document.querySelector('#loginForm').dispatchEvent({ type: 'submit' });
  document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(document.querySelector('#loginDialog').open, true);
  finish(Response.json({ error: 'invalid code' }, { status: 401 }));
  await until(() => !document.querySelector('#accountButton').disabled);
  document.dispatchEvent({ type: 'keydown', key: 'Escape' }); app.flushFrames();
  assert.equal(document.querySelector('#loginDialog').open, false);
  assert.equal(document.querySelector('.notes').inert, false);
});

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'application did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function authFixture(t, origin = 'http://127.0.0.1:5500', config) {
  const { createDatabase } = require('../lib/sqlite-adapter.cjs');
  const admin = require('../lib/login-admin.cjs');
  const { handleApi } = await import('../lib/cloud-api.mjs');
  const db = createDatabase(); t.after(() => db.close());
  db.batch(admin.prepare(db, admin.issue('00123')));
  const sessionDisk = new Map();
  let offline = false;
  const create = () => boot({ origin, sessionDisk, config, apiFetch: (url, options) => {
    if (offline) throw new TypeError('offline');
    return handleApi(new Request(url, { ...options, headers: { ...options.headers, Origin: origin, 'Sec-Fetch-Site': 'cross-site' } }), { DB: db });
  } });
  return { db, sessionDisk, create, setOffline: value => { offline = value; } };
}
async function settled(app) {
  await app.ready;
  await until(() => !app.context.document.querySelector('#accountButton').disabled);
}
async function login(app) {
  await settled(app);
  const document = app.context.document;
  document.querySelector('#loginNumber').value = '00123';
  document.querySelector('#loginForm').dispatchEvent({ type: 'submit' });
  await until(() => document.querySelector('#accountButton').textContent === 'ログイン中' && !document.querySelector('#accountButton').disabled);
}

test('local 5500 reloads restore a real bearer session, and logout clears it', async t => {
  for (const origin of ['http://localhost:5500', 'http://127.0.0.1:5500', 'http://[::1]:5500']) {
    const fixture = await authFixture(t, origin);
    const initial = fixture.create(); await login(initial);
    assert.equal(fixture.sessionDisk.size, 1);
    const saved = JSON.parse([...fixture.sessionDisk.values()][0]);
    assert.deepEqual(Object.keys(saved).sort(), ['expiresAt', 'token']);
    assert.match(saved.token, /^[a-f0-9]{64}$/);
    const reloaded = fixture.create(); await settled(reloaded);
    const document = reloaded.context.document;
    assert.equal(document.querySelector('#accountButton').textContent, 'ログイン中');
    assert.equal(reloaded.requests[0].options.headers.Authorization, 'Bearer ' + saved.token);
    assert.equal(reloaded.requests[0].options.credentials, 'omit');
    document.querySelector('#logoutButton').click();
    await until(() => document.querySelector('#accountButton').textContent === 'ログイン' && !document.querySelector('#accountButton').disabled);
    assert.equal(fixture.sessionDisk.size, 0);
    const afterLogout = fixture.create(); await settled(afterLogout);
    assert.equal(afterLogout.context.document.querySelector('#accountButton').textContent, 'ログイン');
  }
});

test('expired and server-revoked preview sessions are removed rather than restored', async t => {
  const fixture = await authFixture(t);
  const first = fixture.create(); await login(first);
  const [key, serialized] = [...fixture.sessionDisk][0];
  fixture.sessionDisk.set(key, JSON.stringify({ ...JSON.parse(serialized), expiresAt: Date.now() - 1 }));
  const expired = fixture.create(); await settled(expired);
  assert.equal(expired.requests[0].options.headers.Authorization, undefined);
  assert.equal(fixture.sessionDisk.size, 0);
  await login(expired);
  fixture.db.prepare('UPDATE sessions SET expires_at = 0').run();
  expired.context.document.querySelector('#refreshNotes').click();
  await until(() => expired.context.document.querySelector('#accountButton').textContent === 'ログイン');
  assert.equal(fixture.sessionDisk.size, 0);
});

test('temporary preview network failures preserve the session for a later reload', async t => {
  const fixture = await authFixture(t);
  const first = fixture.create(); await login(first);
  fixture.setOffline(true);
  const offline = fixture.create(); await settled(offline);
  assert.equal(fixture.sessionDisk.size, 1);
  fixture.setOffline(false);
  const online = fixture.create(); await settled(online);
  assert.equal(online.context.document.querySelector('#accountButton').textContent, 'ログイン中');
});

test('GitHub Pages keeps its existing memory-only session behavior', async t => {
  const fixture = await authFixture(t, 'https://itachi-kun-itc.github.io', { apiBase: 'https://copynotes-bjx.pages.dev' });
  const first = fixture.create(); await login(first);
  assert.equal(fixture.sessionDisk.size, 0);
  const reloaded = fixture.create(); await settled(reloaded);
  assert.equal(reloaded.context.document.querySelector('#accountButton').textContent, 'ログイン');
});
