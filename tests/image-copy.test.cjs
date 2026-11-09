"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../note-images.js'), 'utf8');
const png = 'data:image/png;base64,aGVsbG8=';
const webp = 'data:image/webp;base64,d29ybGQ=';

function browser({ supported = true, denied = false, broken = false, emptyBlob = false } = {}) {
  const writes = [], draws = [], canvases = [], decodes = [], downloads = [], revoked = [];
  const context = vm.createContext({
    Blob,
    URL: { createObjectURL: blob => { assert.equal(blob.type, 'image/png'); return 'blob:image'; }, revokeObjectURL: url => revoked.push(url) },
    setTimeout: callback => callback(),
    navigator: { clipboard: supported ? {
      write(items) {
        writes.push(items);
        return denied ? Promise.reject(new Error('NotAllowedError')) : Promise.all(items.map(item => Promise.all(Object.values(item.data))));
      },
    } : {} },
    ClipboardItem: class { constructor(data) { this.data = data; } },
    Image: class {
      naturalWidth = 120; naturalHeight = 80;
      decode() {
        return new Promise((resolve, reject) => decodes.push(() => broken ? reject(new Error('Invalid image')) : resolve()));
      }
    },
    document: { body: { append() {} }, createElement(tag) {
      if (tag === 'a') return { click() { downloads.push({ href: this.href, name: this.download }); }, remove() {} };
      assert.equal(tag, 'canvas');
      const canvas = {
        getContext: () => ({ drawImage: (...args) => draws.push(args) }),
        toBlob: (callback, type) => callback(emptyBlob ? null : new Blob(['encoded'], { type })),
      };
      canvases.push(canvas); return canvas;
    } },
  });
  vm.runInContext(source, context);
  return { images: context.CopyNotesImages, writes, draws, canvases, decodes, downloads, revoked };
}

test('copy writes in the click gesture before image decoding completes, using a PNG for an image-only note', async () => {
  const b = browser();
  const promise = b.images.copy('', [webp]);
  assert.equal(b.writes.length, 1, 'clipboard permission must be requested before any await');
  assert.equal(b.writes[0].length, 1);
  assert.equal(b.canvases.length, 0);
  const data = b.writes[0][0].data;
  assert.equal(data['text/plain'], undefined);
  b.decodes.forEach(decode => decode()); await promise;
  assert.equal((await data['image/png']).type, 'image/png');
  assert.equal(b.canvases[0].width, 120); assert.equal(b.canvases[0].height, 80);
  assert.equal(b.draws[0][0].src, webp);
});

test('copy snapshots a single image', async () => {
  const b = browser();
  const images = [png];
  const text = '';
  const promise = b.images.copy(text, images);
  images.length = 0;
  b.decodes.forEach(decode => decode()); await promise;
  assert.equal(b.writes[0].length, 1, 'one item works on platforms which only support a single clipboard item');
  const data = b.writes[0][0].data;
  assert.equal(data['text/plain'], undefined);
  const html = await data['text/html'].text();
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.ok(!html.includes('<script>'));
  assert.equal(b.canvases[0].width, 120); assert.equal(b.canvases[0].height, 80);
  assert.deepEqual(b.draws.map(args => [args[0].src, args[1], args[2]]), [[png, 0, 0]]);
});

test('unsupported clipboards and invalid images fail instead of silently copying text or only one image', async () => {
  const unsupported = browser({ supported: false });
  await assert.rejects(unsupported.images.copy('', [png]), /画像のコピーに対応していません/);
  const b = browser();
  for (const images of [[], [png, png], ['javascript:alert(1)']]) await assert.rejects(b.images.copy('', images), /コピーする画像/);
  await assert.rejects(b.images.copy('text', [png]), /コピーする画像/);
  assert.equal(b.writes.length, 0);
});

test('decoding, PNG encoding and permission failures reject the copy operation', async () => {
  for (const options of [{ broken: true }, { emptyBlob: true }, { denied: true }]) {
    const b = browser(options);
    const promise = b.images.copy('', [png]);
    const rejection = assert.rejects(promise);
    b.decodes.forEach(decode => decode());
    await rejection;
  }
});

test('images can be exported as one PNG for download without clipboard support', async () => {
  const b = browser({ supported: false });
  assert.equal(b.images.canCopy(), false);
  const promise = b.images.toPng([png]);
  b.decodes.forEach(decode => decode());
  const blob = await promise;
  assert.equal(blob.type, 'image/png'); assert.equal(b.writes.length, 0);
  assert.equal(b.canvases[0].height, 80);
  assert.deepEqual(b.draws.map(args => args[2]), [0]);
});

test('download saves a PNG and releases its object URL independently of clipboard support', async () => {
  const b = browser({ supported: false });
  const promise = b.images.download([webp]);
  assert.equal(b.downloads.length, 0);
  b.decodes.forEach(decode => decode()); await promise;
  assert.deepEqual(b.downloads, [{ href: 'blob:image', name: 'copynotes-image.png' }]);
  assert.deepEqual(b.revoked, ['blob:image']); assert.equal(b.writes.length, 0);
});
