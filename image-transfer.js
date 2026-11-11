"use strict";

if (typeof require === 'function') require('./note-images.js');

globalThis.CopyNotesImageTransfer = (() => {
  const images = globalThis.CopyNotesImages;
  function create(request) {
    // Room-scoped caches never authorize access; every request checks the session.
    const uploaded = new Map(), downloaded = new Map(), partial = new Map();
    async function upload(src, room) {
      if (!images.valid([src])) throw new Error('画像を確認してください');
      const key = room + ':' + src;
      if (uploaded.has(key)) {
        const reference = uploaded.get(key);
        try { await request('images/' + images.referenceId(reference)); return reference; }
        catch (error) { if (error.status !== 404) throw error; uploaded.delete(key); }
      }
      const comma = src.indexOf(','), data = src.slice(comma + 1);
      if (images.byteLength(src) <= images.inlineBytes) return src;
      const id = partial.get(key) || crypto.randomUUID();
      partial.set(key, id);
      const mime = src.slice(5, src.indexOf(';'));
      const bytes = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
      const manifest = await request('images', 'POST', { id, mime, bytes });
      if (!manifest.complete) {
        for (let offset = 0, index = 0; offset < data.length; offset += images.chunkLength, index++) {
          await request('images/' + id + '/' + index, 'POST', { data: data.slice(offset, offset + images.chunkLength) });
        }
        await request('images/' + id + '/complete', 'POST', {});
      }
      const reference = images.referencePrefix + id;
      uploaded.set(key, reference); downloaded.set(room + ':' + reference, src); partial.delete(key);
      return reference;
    }
    async function download(reference, room) {
      const id = images.referenceId(reference);
      if (!id) {
        if (!images.valid([reference])) throw new Error('共有画像の形式を確認してください');
        return reference;
      }
      const key = room + ':' + reference;
      if (downloaded.has(key)) return downloaded.get(key);
      const manifest = await request('images/' + id);
      if (!manifest.complete || !['image/png', 'image/jpeg', 'image/webp'].includes(manifest.mime)
        || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > images.maxBytes
        || manifest.chunks !== Math.ceil(4 * Math.ceil(manifest.bytes / 3) / images.chunkLength)) throw new Error('共有画像の形式を確認してください');
      const chunks = [];
      for (let index = 0; index < manifest.chunks; index++) {
        const result = await request('images/' + id + '/' + index);
        if (typeof result.data !== 'string' || result.data.length > images.chunkLength) throw new Error('共有画像を読み込めませんでした');
        chunks.push(result.data);
      }
      const src = 'data:' + manifest.mime + ';base64,' + chunks.join('');
      if (!images.valid([src]) || images.byteLength(src) !== manifest.bytes) throw new Error('共有画像を読み込めませんでした');
      downloaded.set(key, src); uploaded.set(room + ':' + src, reference);
      return src;
    }
    async function encode(operations, room) {
      const result = [];
      for (const operation of operations) {
        const sources = [];
        for (const src of operation.images || []) sources.push(await upload(src, room));
        result.push({ ...operation, images: sources });
      }
      return result;
    }
    async function decode(notes, room) {
      const result = [];
      for (const note of notes) {
        const sources = [];
        for (const src of note.images || []) sources.push(await download(src, room));
        result.push({ ...note, images: sources });
      }
      return result;
    }
    return Object.freeze({ encode, decode });
  }
  return Object.freeze({ create });
})();
