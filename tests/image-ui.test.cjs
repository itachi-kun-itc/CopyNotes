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
  focus() { this.ownerDocument.activeElement = this; }
  get isConnected() { return this.connected || Boolean(this.parentElement?.isConnected); }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
}

function boot({ clipboard = true, formats = ['image/png', 'text/plain'], indexedDB, authenticated = false, savedDisk } = {}) {
  const document = new Element('document'); document.connected = true; document.ownerDocument = document;
  document.visibilityState = 'hidden'; document.baseURI = 'http://localhost/'; document.body = document;
  document.createElement = tag => { const element = new Element(tag); element.ownerDocument = document; return element; };
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const nodes = new Map();
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/g)) {
    const element = document.createElement(match[1]); element.id = match[2]; nodes.set('#' + element.id, element); document.append(element);
  }
  for (const name of ['notes', 'notes-scroll', 'workspace-tabs']) { const element = document.createElement('div'); element.className = name; nodes.set('.' + name, element); document.append(element); }
  document.querySelector = selector => nodes.get(selector) || null;
  nodes.get('#noteTemplate').content = { firstElementChild: { cloneNode() {
    const row = document.createElement('div'); row.className = 'note-row';
    for (const [tag, className] of [['pre', 'note-highlight'], ['textarea', 'note-input'], ['button', 'copy-button'], ['button', 'download-button'], ['div', 'note-images'], ['span', 'image-count'], ['button', 'attach-image'], ['input', 'image-input']]) {
      const child = document.createElement(tag); child.className = className; row.append(child);
    }
    return row;
  } } };
  const disk = savedDisk || new Map(), downloads = [], copiedImages = [];
  let selectTab;
  const context = vm.createContext({ document, window: new Element('window'), crypto, URL, Blob, atob, Uint8Array,
    navigator: { onLine: true, clipboard: clipboard ? { write: async () => {} } : undefined }, location: { origin: 'http://localhost' },
    ClipboardItem: class { constructor(data) { this.data = data; } static supports(type) { return formats.includes(type); } },
    indexedDB,
    localStorage: { get length() { return disk.size; }, key: index => [...disk.keys()][index], getItem: key => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, value) },
    setTimeout: (callback, delay) => { if (!delay) queueMicrotask(callback); return 1; }, clearTimeout() {}, requestAnimationFrame: () => 1,
    AbortController, fetch: async url => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => String(url).endsWith('/notes') ? { notes: [] } : { authenticated, roomId: authenticated ? 'room' : null } }),
    CopyNotesTouch: { attach: () => ({ cancel() {}, active: false }) },
    CopyNotesAutoSync: { create: () => ({ changed() {}, refresh() {}, pause() {} }) },
    CopyNotesTabs: { attach: (element, options) => { selectTab = options.onChange; return { sync() {} }; } },
    CopyNotesSyntax: { detect: () => null, tokenize: () => [] },
    CopyNotesLinks: { find: () => [], render: () => document.createElement('span') },
    CopyNotesLimits: { attach() {} }, CopyNotesEditor: { attach() {} },
  });
  for (const file of ['note-images.js', 'attachment-storage.js', 'image-transfer.js', 'sharing.js', 'device-storage.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  context.CopyNotesImages = { ...context.CopyNotesImages, prepare: async file => file.src, copy: async (text, sources) => copiedImages.push([...sources]), download: async sources => downloads.push([...sources]) };
  const ready = vm.runInContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context);
  const list = nodes.get('#noteList');
  return { ready, tab: index => selectTab(index), row: () => list.children[0], add: () => nodes.get('#addNote').click(), list, disk, downloads, copiedImages, context };
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
