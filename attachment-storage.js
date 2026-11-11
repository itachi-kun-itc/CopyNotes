"use strict";

// Only short image references go into localStorage. Commit image bytes to
// IndexedDB first, so a failed write cannot leave a note pointing at lost data.
globalThis.CopyNotesAttachmentStorage = (() => {
  const prefix = 'copynotes-local-image:';
  const relevant = key => /^copynotes\.(?:notes\.|shared\.)/.test(key);
  const mapImages = (notes, transform) => Array.isArray(notes) ? notes.map(note => {
    if (!note || typeof note !== 'object') return note;
    const result = { ...note };
    for (const field of ['images', 'originalImages']) if (Array.isArray(note[field])) result[field] = note[field].map(transform);
    return result;
  }) : notes;
  async function open({ storage, indexedDB, onError = () => {} }) {
    const byId = new Map(), bySource = new Map(), created = new Map();
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('copynotes.attachments', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('images', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('画像の保存先を更新できません。他のタブを閉じて再読み込みしてください'));
    });
    db.onversionchange = () => db.close();
    function remember(record) { byId.set(record.id, record.src); bySource.set(record.src, record.id); created.set(record.id, record.createdAt); }
    async function refresh() {
      const records = await new Promise((resolve, reject) => {
        const transaction = db.transaction('images', 'readonly');
        const request = transaction.objectStore('images').getAll();
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error || new Error('画像を読み込めませんでした'));
      });
      byId.clear(); bySource.clear(); created.clear();
      records.forEach(remember);
    }
    async function put(src) {
      if (bySource.has(src) && created.get(bySource.get(src)) >= Date.now() - 86400000) return;
      const record = { id: crypto.randomUUID(), src, createdAt: Date.now() };
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('images', 'readwrite');
        transaction.objectStore('images').put(record);
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || new Error('画像を保存できませんでした。端末の空き容量を確認してください'));
      });
      remember(record);
    }
    const adapter = {
      getNotes(key) {
        const value = storage.getItem(key);
        if (value === null) return null;
        return mapImages(JSON.parse(value), item => {
          if (typeof item !== 'string' || !item.startsWith(prefix)) return item;
          const src = byId.get(item.slice(prefix.length));
          if (!src) throw new Error('保存された画像を読み込めません。再読み込みしてください');
          return src;
        });
      },
      setNotes(key, notes) {
        const value = JSON.stringify(mapImages(notes, item => typeof item === 'string' && bySource.has(item) ? prefix + bySource.get(item) : item));
        if (storage.getItem(key) !== value) storage.setItem(key, value);
      },
      getItem: key => {
        if (!relevant(key)) return storage.getItem(key);
        const notes = adapter.getNotes(key);
        return notes === null ? null : JSON.stringify(notes);
      },
      setItem: (key, value) => relevant(key) ? adapter.setNotes(key, JSON.parse(value)) : storage.setItem(key, value),
      put, refresh,
      async retain(notes) {
        for (const note of notes) for (const src of [...(note.images || []), ...(note.originalImages || [])]) await put(src);
      },
      close: () => db.close(),
    };
    await refresh();
    // Migrate existing images only after their new durable copy succeeds.
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!relevant(key)) continue;
      try {
        const notes = adapter.getNotes(key);
        if (!Array.isArray(notes)) continue;
        await adapter.retain(notes);
        adapter.setNotes(key, notes);
      } catch (error) {
        if (error.message.startsWith('保存された画像')) { db.close(); throw error; }
        onError(error);
      }
    }
    // Reclaim deleted originals after a day, allowing time for another tab to
    // finish attaching an image that has been stored but not referenced yet.
    const referenced = new Set();
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!relevant(key)) continue;
      try { mapImages(JSON.parse(storage.getItem(key)), value => {
        if (typeof value === 'string' && value.startsWith(prefix)) referenced.add(value.slice(prefix.length));
        return value;
      }); } catch { /* Invalid legacy metadata is handled by the note store. */ }
    }
    const expired = [...created].filter(([id, time]) => time < Date.now() - 86400000 && !referenced.has(id));
    if (expired.length) await new Promise((resolve, reject) => {
      const transaction = db.transaction('images', 'readwrite');
      for (const [id] of expired) transaction.objectStore('images').delete(id);
      transaction.oncomplete = () => {
        for (const [id] of expired) { const src = byId.get(id); byId.delete(id); if (bySource.get(src) === id) bySource.delete(src); created.delete(id); }
        resolve();
      };
      transaction.onabort = () => reject(transaction.error);
    });
    return adapter;
  }
  return Object.freeze({ open });
})();
