"use strict";

globalThis.CopyNotesImages = (() => {
  const maxImages = 1;
  // Encoded images fit comfortably in a single sync request and DB row.
  const maxBytes = 192 * 1024;
  const maxEncodedLength = 4 * Math.ceil(maxBytes / 3);
  const valid = (images, limit = maxImages) => images === undefined || Array.isArray(images) && images.length <= limit
    && images.every(src => {
      if (typeof src !== 'string' || src.length > maxEncodedLength + 24 || !/^data:image\/(?:png|jpeg|webp);base64,/.test(src)) return false;
      const data = src.slice(src.indexOf(',') + 1);
      return data.length > 0 && data.length <= maxEncodedLength && data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data);
    });
  const equal = (a = [], b = []) => a.length === b.length && a.every((src, index) => src === b[index]);
  const isBlank = note => !note.text.trim() && !note.images?.length;
  const validNote = note => typeof note.text === 'string' && valid(note.images) && !(note.text.length && note.images?.length);
  const equalNote = (a, b) => a.text === b.text && equal(a.images, b.images);
  function split(note) {
    if (validNote(note)) return [note];
    const parts = [];
    if (note.text.length) parts.push({ ...note, images: [] });
    const images = note.images || [];
    // Match the stable IDs used by the two image migrations.
    for (let offset = 0; offset < images.length; offset += 2) {
      parts.push({ ...note, id: parts.length ? note.id + '-images-' + (offset / 2 + Number(note.text.length > 0)) : note.id,
        text: '', images: images.slice(offset, offset + 2) });
    }
    return (parts.length ? parts : [note]).flatMap(part => (part.images || []).length > 1
      ? part.images.map((src, index) => ({ ...part, id: index ? part.id + '-photo-' + (index + 1) : part.id, images: [src] })) : [part]);
  }
  const filesFrom = data => {
    const items = Array.from(data?.items || []).filter(item => item.kind === 'file' && item.type.startsWith('image/'));
    return items.length ? items.map(item => item.getAsFile()).filter(Boolean)
      : Array.from(data?.files || []).filter(file => file.type.startsWith('image/'));
  };
  function read(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('画像を読み込めませんでした'));
      reader.readAsDataURL(file);
    });
  }
  async function prepare(file) {
    const image = new Image();
    image.src = await read(file);
    try { await image.decode(); } catch { throw new Error('この画像は読み込めませんでした'); }
    const canvas = document.createElement('canvas');
    let scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    for (let attempt = 0; attempt < 7; attempt++, scale *= .75) {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const png = canvas.toDataURL('image/png');
      if (png.length <= maxEncodedLength + 22) return png;
      const compressed = canvas.toDataURL('image/webp', .82);
      if (compressed.length <= maxEncodedLength + 23) return compressed;
    }
    throw new Error('画像が大きすぎます。小さい画像をお試しください');
  }
  async function toPng(sources) {
    const images = [...sources];
    if (!images.length || !valid(images)) throw new Error('画像を確認してください');
    const decoded = await Promise.all(images.map(async src => {
      const image = new Image(); image.src = src; await image.decode(); return image;
    }));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(...decoded.map(image => image.naturalWidth));
    canvas.height = decoded.reduce((height, image) => height + image.naturalHeight, 0);
    const context = canvas.getContext('2d');
    let top = 0;
    for (const image of decoded) {
      context.drawImage(image, 0, top); top += image.naturalHeight;
    }
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('画像を変換できませんでした')), 'image/png'));
  }
  function canCopy() {
    if (!globalThis.navigator?.clipboard?.write || !globalThis.ClipboardItem) return false;
    try { return typeof ClipboardItem.supports !== 'function' || ClipboardItem.supports('image/png'); }
    catch { return false; }
  }
  async function copy(text, sources) {
    if (!canCopy()) throw new Error('このブラウザは画像のコピーに対応していません');
    const images = [...sources];
    if (text || !images.length || !valid(images)) throw new Error('コピーする画像を確認してください');
    const png = toPng(images);
    // A permission denial may happen before the browser consumes this promise.
    png.catch(() => {});
    const html = '<div>' + images.map(src => '<p><img src="' + src + '"></p>').join('') + '</div>';
    const data = { 'image/png': png, 'text/html': new Blob([html], { type: 'text/html' }) };
    // Keep write() in the click gesture; Safari accepts deferred image encoding.
    // Use one ClipboardItem: some platforms only write the first item in a list.
    await navigator.clipboard.write([new ClipboardItem(data)]);
  }
  async function download(sources) {
    const blob = await toPng(sources);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'copynotes-image.png';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return Object.freeze({ maxImages, maxBytes, valid, equal, isBlank, validNote, equalNote, split, filesFrom, prepare, toPng, canCopy, copy, download });
})();
