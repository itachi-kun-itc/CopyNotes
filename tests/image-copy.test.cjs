"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../note-images.js'), 'utf8');
const png = 'data:image/png;base64,aGVsbG8=';
const webp = 'data:image/webp;base64,d29ybGQ=';
const jpeg = 'data:image/jpeg;base64,anBlZw==';

function browser({ supported = true, denied = false, broken = false, emptyBlob = false, width = 120, height = 80, encoded = png } = {}) {
  const writes = [], draws = [], canvases = [], decodes = [], downloads = [], revoked = [], blobs = [], reads = [], encodings = [];
  const context = vm.createContext({
    Blob, atob,
    FileReader: class {
      readAsDataURL(file) { reads.push(file); this.result = file.src; this.onload(); }
    },
    URL: { createObjectURL: blob => { blobs.push(blob); return 'blob:image'; }, revokeObjectURL: url => revoked.push(url) },
    setTimeout: callback => callback(),
    navigator: { clipboard: supported ? {
      write(items) {
        writes.push(items);
        return denied ? Promise.reject(new Error('NotAllowedError')) : Promise.all(items.map(item => Promise.all(Object.values(item.data))));
      },
    } : {} },
    ClipboardItem: class { constructor(data) { this.data = data; } },
    Image: class {
      naturalWidth = width; naturalHeight = height;
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
        toDataURL: (...args) => { encodings.push(args); return encoded; },
      };
      canvases.push(canvas); return canvas;
    } },
  });
  vm.runInContext(source, context);
  return { images: context.CopyNotesImages, writes, draws, canvases, decodes, downloads, revoked, blobs, reads, encodings };
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
  const images = [webp];
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
  assert.deepEqual(b.draws.map(args => [args[0].src, args[1], args[2]]), [[webp, 0, 0]]);
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
    const promise = b.images.copy('', [webp]);
    const rejection = assert.rejects(promise);
    b.decodes.forEach(decode => decode());
    await rejection;
  }
});

test('PNG export keeps the original bytes without canvas re-encoding', async () => {
  const b = browser({ supported: false });
  assert.equal(b.images.canCopy(), false);
  const promise = b.images.toPng([png]);
  b.decodes.forEach(decode => decode());
  const blob = await promise;
  assert.equal(blob.type, 'image/png'); assert.equal(b.writes.length, 0);
  assert.equal(await blob.text(), 'hello');
  assert.equal(b.canvases.length, 0);
});

test('downloads preserve original PNG, JPEG and WebP bytes and release their object URLs', async () => {
  for (const [src, type, extension, bytes] of [[png, 'image/png', 'png', 'hello'], [jpeg, 'image/jpeg', 'jpg', 'jpeg'], [webp, 'image/webp', 'webp', 'world']]) {
    const b = browser({ supported: false });
    await b.images.download([src]);
    assert.deepEqual(b.downloads, [{ href: 'blob:image', name: 'copynotes-image.' + extension }]);
    assert.equal(b.blobs[0].type, type); assert.equal(await b.blobs[0].text(), bytes);
    assert.equal(b.canvases.length, 0);
    assert.deepEqual(b.revoked, ['blob:image']); assert.equal(b.writes.length, 0);
  }
});

test('attachments retain full resolution and original bytes above the old size limit', async () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
    const b = browser({ width: 4096, height: 2160 });
    const src = 'data:' + type + ';base64,' + Buffer.alloc(300 * 1024, 123).toString('base64');
    const promise = b.images.prepare({ type, size: 300 * 1024, src });
    await Promise.resolve(); b.decodes.forEach(decode => decode());
    assert.equal(await promise, src); assert.equal(b.canvases.length, 0);
  }
});

test('unsupported image formats use lossless PNG at the original dimensions', async () => {
  const b = browser({ width: 4096, height: 2160 });
  const promise = b.images.prepare({ type: 'image/gif', src: 'data:image/gif;base64,R0lG' });
  await Promise.resolve(); b.decodes.forEach(decode => decode());
  assert.equal(await promise, png);
  assert.equal(b.canvases[0].width, 4096); assert.equal(b.canvases[0].height, 2160);
  assert.deepEqual(b.encodings, [['image/png']]);
  assert.equal(b.draws[0].length, 3);
});

test('oversized originals and lossless conversions fail without reducing image quality', async () => {
  const b = browser();
  await assert.rejects(b.images.prepare({ type: 'image/jpeg', size: b.images.maxBytes + 1 }), /1MiB以下/);
  assert.equal(b.reads.length, 0); assert.equal(b.canvases.length, 0);
  const oversized = 'data:image/png;base64,' + Buffer.alloc(b.images.maxBytes + 1).toString('base64');
  for (const src of [oversized, 'data:image/gif;base64,R0lG']) {
    const c = browser({ width: 4096, height: 2160, encoded: oversized });
    const promise = c.images.prepare({ type: src.includes('gif') ? 'image/gif' : 'image/png', src });
    await Promise.resolve(); c.decodes.forEach(decode => decode());
    await assert.rejects(promise, /1MiB以下/);
    assert.ok(c.encodings.every(args => args.length === 1 && args[0] === 'image/png'));
  }
});

test('copy keeps full image dimensions for JPEG and WebP and exact original PNG bytes', async () => {
  for (const src of [png, jpeg, webp]) {
    const b = browser({ width: 4096, height: 2160 });
    const promise = b.images.copy('', [src]);
    assert.equal(b.writes.length, 1);
    b.decodes.forEach(decode => decode()); await promise;
    const blob = await b.writes[0][0].data['image/png'];
    if (src === png) { assert.equal(await blob.text(), 'hello'); assert.equal(b.canvases.length, 0); }
    else { assert.equal(b.canvases[0].width, 4096); assert.equal(b.canvases[0].height, 2160); }
  }
});
