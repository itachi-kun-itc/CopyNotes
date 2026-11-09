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
  const writes = [], draws = [], canvases = [], decodes = [];
  const context = vm.createContext({
    Blob,
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
    document: { createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        getContext: () => ({ drawImage: (...args) => draws.push(args) }),
        toBlob: (callback, type) => callback(emptyBlob ? null : new Blob(['encoded'], { type })),
      };
      canvases.push(canvas); return canvas;
    } },
  });
  vm.runInContext(source, context);
  return { images: context.CopyNotesImages, writes, draws, canvases, decodes };
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

test('copy retains all three images in order and snapshots the contents while also escaping text in HTML', async () => {
  const b = browser();
  const images = [png, webp, png];
  const text = '<script>alert("x")</script> &\nsecond line';
  const promise = b.images.copy(text, images);
  images.length = 0;
  b.decodes.forEach(decode => decode()); await promise;
  assert.equal(b.writes[0].length, 1, 'one item works on platforms which only support a single clipboard item');
  const data = b.writes[0][0].data;
  assert.equal(await data['text/plain'].text(), text);
  const html = await data['text/html'].text();
  assert.equal((html.match(/<img /g) || []).length, 3);
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp;\nsecond line'));
  assert.ok(!html.includes('<script>'));
  assert.equal(b.canvases[0].width, 120); assert.equal(b.canvases[0].height, 240);
  assert.deepEqual(b.draws.map(args => [args[0].src, args[1], args[2]]), [[png, 0, 0], [webp, 0, 80], [png, 0, 160]]);
});

test('unsupported clipboards and invalid images fail instead of silently copying text or only one image', async () => {
  const unsupported = browser({ supported: false });
  await assert.rejects(unsupported.images.copy('', [png]), /画像のコピーに対応していません/);
  const b = browser();
  for (const images of [[], [png, png, png, png], ['javascript:alert(1)']]) await assert.rejects(b.images.copy('text', images), /コピーする画像/);
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
