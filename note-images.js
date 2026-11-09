"use strict";

globalThis.CopyNotesImages = (() => {
  const maxImages = 3;
  // Three encoded images fit comfortably in a single sync request and DB row.
  const maxBytes = 192 * 1024;
  const maxEncodedLength = 4 * Math.ceil(maxBytes / 3);
  const valid = images => images === undefined || Array.isArray(images) && images.length <= maxImages
    && images.every(src => {
      if (typeof src !== 'string' || src.length > maxEncodedLength + 24 || !/^data:image\/(?:png|jpeg|webp);base64,/.test(src)) return false;
      const data = src.slice(src.indexOf(',') + 1);
      return data.length > 0 && data.length <= maxEncodedLength && data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data);
    });
  const equal = (a = [], b = []) => a.length === b.length && a.every((src, index) => src === b[index]);
  const isBlank = note => !note.text.trim() && !note.images?.length;
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
  return Object.freeze({ maxImages, maxBytes, valid, equal, isBlank, filesFrom, prepare });
})();
