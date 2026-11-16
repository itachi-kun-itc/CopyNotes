"use strict";

// Originals stay as Blobs in IndexedDB. Neither localStorage nor note sync
// contains a base64 copy of a potentially 300 MB file.
globalThis.CopyNotesVideos = (() => {
  const maxBytes = 300000000, maxDuration = 30;
  const prefix = 'copynotes-video:';
  const clipboardPrefix = 'CopyNotes動画:';
  const mimeTypes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg', 'video/x-m4v'];
  const referenceId = src => typeof src === 'string' && /^copynotes-video:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(src) ? src.slice(prefix.length) : null;
  const validMetadata = value => value && mimeTypes.includes(value.mime)
    && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= maxBytes
    && Number.isFinite(value.duration) && value.duration > 0 && value.duration <= maxDuration;
  let database;
  async function open() {
    if (!globalThis.indexedDB) throw new Error('動画の保存にはIndexedDBが使えるブラウザが必要です');
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open('copynotes.videos', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('videos', { keyPath: 'id' });
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = null; }; resolve(request.result); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('動画の保存先を開けません。他のタブを閉じて再読み込みしてください'));
    }).catch(error => { database = null; throw error; });
    return database;
  }
  async function get(reference) {
    const id = referenceId(reference);
    if (!id) throw new Error('動画の形式を確認してください');
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('videos', 'readonly');
      const request = transaction.objectStore('videos').get(id);
      transaction.oncomplete = () => resolve(request.result || null);
      transaction.onabort = () => reject(transaction.error || new Error('動画を読み込めませんでした'));
    });
  }
  async function put(reference, blob, metadata) {
    const id = referenceId(reference);
    if (!id || !validMetadata(metadata) || blob.size !== metadata.bytes || blob.type !== metadata.mime) throw new Error('動画の形式・サイズを確認してください');
    const db = await open();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('videos', 'readwrite');
      transaction.objectStore('videos').put({ id, blob, mime: metadata.mime, bytes: metadata.bytes, duration: metadata.duration });
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || new Error('動画を保存できませんでした。端末の空き容量を確認してください'));
    });
  }
  function durationOf(file) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video'), url = URL.createObjectURL(file);
      const finish = (error) => {
        clearTimeout(timer); video.onloadedmetadata = video.onerror = null;
        video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
        error ? reject(error) : resolve(video.duration);
      };
      const timer = setTimeout(() => finish(new Error('動画の長さを確認できませんでした')), 30000);
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        const duration = video.duration;
        // Capture before clearing the player, which can reset duration.
        clearTimeout(timer); video.onloadedmetadata = video.onerror = null;
        video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
        Number.isFinite(duration) && duration > 0 ? resolve(duration) : reject(new Error('動画の長さを確認できませんでした'));
      };
      video.onerror = () => finish(new Error('この動画は読み込めません。対応する動画形式を選んでください'));
      video.src = url;
    });
  }
  async function prepare(file) {
    if (!mimeTypes.includes(file.type)) throw new Error('MP4・WebM・MOVなどの対応する動画を選んでください');
    if (file.size < 1 || file.size > maxBytes) throw new Error('動画は300MB以下にしてください');
    const duration = await durationOf(file);
    if (duration > maxDuration) throw new Error('動画は30秒以下にしてください');
    const reference = prefix + crypto.randomUUID();
    await put(reference, file, { mime: file.type, bytes: file.size, duration });
    return reference;
  }
  async function download(reference) {
    const record = await get(reference);
    if (!record) throw new Error('保存された動画が見つかりません。共有先を再読み込みしてください');
    const url = URL.createObjectURL(record.blob);
    const extension = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv', 'video/x-m4v': 'm4v' }[record.mime];
    const link = document.createElement('a'); link.href = url; link.download = 'copynotes-video.' + extension;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  // Browsers do not expose native file clipboard writes. A small reference
  // supports lossless copies inside CopyNotes even for the largest originals.
  const canCopy = () => Boolean(globalThis.navigator?.clipboard?.writeText);
  async function copy(reference) {
    if (!canCopy()) throw new Error('このブラウザは動画のコピーに対応していません。DLをご利用ください');
    if (!referenceId(reference)) throw new Error('コピーする動画を確認してください');
    await navigator.clipboard.writeText(clipboardPrefix + reference);
  }
  const fromClipboard = data => {
    const text = data?.getData?.('text/plain') || '';
    return text.startsWith(clipboardPrefix) && referenceId(text.slice(clipboardPrefix.length)) ? text.slice(clipboardPrefix.length) : null;
  };
  function createTransfer(request) {
    const uploaded = new Set();
    const chunkBytes = 3 * 256 * 1024;
    async function upload(reference, room) {
      const id = referenceId(reference), key = room + ':' + reference;
      if (uploaded.has(key)) {
        try { await request('images/' + id); return reference; }
        catch (error) { if (error.status !== 404) throw error; uploaded.delete(key); }
      }
      const record = await get(reference);
      if (!record) throw new Error('共有する動画が見つかりません');
      const manifest = await request('images', 'POST', { id, mime: record.mime, bytes: record.bytes, duration: record.duration });
      if (!manifest.complete) {
        for (let offset = 0, index = 0; offset < record.bytes; offset += chunkBytes, index++) {
          const bytes = new Uint8Array(await record.blob.slice(offset, offset + chunkBytes).arrayBuffer());
          let binary = '';
          for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
          await request('images/' + id + '/' + index, 'POST', { data: btoa(binary) });
        }
        await request('images/' + id + '/complete', 'POST', {});
      }
      uploaded.add(key); return reference;
    }
    async function download(reference) {
      const id = referenceId(reference);
      const manifest = await request('images/' + id);
      if (!manifest.complete || !validMetadata(manifest) || manifest.chunks !== Math.ceil(manifest.bytes / chunkBytes)) throw new Error('共有動画の形式を確認してください');
      const saved = await get(reference);
      if (saved && saved.bytes === manifest.bytes && saved.mime === manifest.mime && saved.duration === manifest.duration) return reference;
      const chunks = [];
      for (let index = 0; index < manifest.chunks; index++) {
        const { data } = await request('images/' + id + '/' + index);
        const expected = 4 * Math.ceil(Math.min(chunkBytes, manifest.bytes - index * chunkBytes) / 3);
        if (typeof data !== 'string' || data.length !== expected || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('共有動画を読み込めませんでした');
        chunks.push(Uint8Array.from(atob(data), char => char.charCodeAt(0)));
      }
      await put(reference, new Blob(chunks, { type: manifest.mime }), manifest);
      return reference;
    }
    return Object.freeze({ upload, download });
  }
  return Object.freeze({ maxBytes, maxDuration, prefix, referenceId, mimeTypes, validMetadata, get, put, prepare, download, copy, canCopy, fromClipboard, createTransfer });
})();
