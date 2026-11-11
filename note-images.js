"use strict";

globalThis.CopyNotesImages = (() => {
  const maxImages = 1;
  const maxImageNotes = 3;
  // Large originals are stored separately and synchronized in small chunks.
  const maxBytes = 20 * 1024 * 1024;
  const inlineBytes = 1024 * 1024;
  const chunkLength = 1024 * 1024; // Base64 characters, divisible by four.
  const referencePrefix = 'copynotes-image:';
  const referenceId = src => typeof src === 'string' && /^copynotes-image:[a-f0-9-]{36}$/.test(src) ? src.slice(referencePrefix.length) : null;
  const maxEncodedLength = 4 * Math.ceil(maxBytes / 3);
  const byteLength = src => {
    const data = src.slice(src.indexOf(',') + 1);
    return data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  };
  const valid = (images, limit = maxImages) => images === undefined || Array.isArray(images) && images.length <= limit
    && images.every(src => {
      if (typeof src !== 'string' || src.length > maxEncodedLength + 24 || !/^data:image\/(?:png|jpeg|webp);base64,/.test(src)) return false;
      const data = src.slice(src.indexOf(',') + 1);
      const bytes = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
      return data.length > 0 && data.length <= maxEncodedLength && bytes <= maxBytes && data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data);
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
    const tooLarge = () => new Error('画質を保つため、20MiB以下の画像を添付してください');
    if (/^image\/(?:png|jpeg|webp)$/.test(file.type) && file.size > maxBytes) throw tooLarge();
    const src = await read(file);
    const image = new Image();
    image.src = src;
    try { await image.decode(); } catch { throw new Error('この画像は読み込めませんでした'); }
    // Keep supported files byte-for-byte, including their original resolution.
    if (valid([src])) return src;
    if (/^data:image\/(?:png|jpeg|webp);base64,/.test(src)) throw tooLarge();
    // Other browser-readable formats use lossless PNG at their natural size.
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    const png = canvas.toDataURL('image/png');
    if (valid([png])) return png;
    throw tooLarge();
  }
  function toBlob(src) {
    const [header, data] = src.split(',');
    const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
    return new Blob([bytes], { type: header.slice(5, header.indexOf(';')) });
  }
  async function toPng(sources) {
    const images = [...sources];
    if (!images.length || !valid(images)) throw new Error('画像を確認してください');
    if (images[0].startsWith('data:image/png;')) return toBlob(images[0]);
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
    const images = [...sources];
    if (!images.length || !valid(images)) throw new Error('画像を確認してください');
    const blob = toBlob(images[0]);
    const url = URL.createObjectURL(blob);
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[blob.type];
    const link = document.createElement('a'); link.href = url; link.download = 'copynotes-image.' + extension;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return Object.freeze({ maxImages, maxImageNotes, maxBytes, inlineBytes, chunkLength, referencePrefix, referenceId, byteLength, valid, equal, isBlank, validNote, equalNote, split, filesFrom, prepare, toPng, canCopy, copy, download });
})();
