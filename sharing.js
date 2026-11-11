"use strict";

if (typeof require === 'function') require('./note-images.js');

globalThis.CopyNotesSharing = (() => {
  const id = () => crypto.randomUUID();
  const isBlank = (text, images = []) => text.trim().length === 0 && images.length === 0;
  function draft(text = "", images = []) {
    return { id: id(), text, images: [...images], version: 0, order: null, position: 0, syncedAt: null, deleted: false, dirty: true, originalText: "", originalImages: [], mutationId: id() };
  }
  function clean(note) { return { ...note, dirty: false, originalText: note.text, originalImages: [...(note.images || [])] }; }
  function normalizeLegacy(notes) {
    const keys = ['id', 'text', 'images', 'version', 'order', 'position', 'syncedAt', 'deleted', 'dirty', 'originalText', 'originalImages', 'mutationId', 'pendingMutationId'];
    return notes.flatMap(value => {
      const note = Object.fromEntries(keys.filter(key => key in value).map(key => [key, value[key]]));
      if (note.deleted || CopyNotesImages.validNote(note)) return [note];
      return CopyNotesImages.split(note).map((part, index) => index === 0
        ? { ...part, dirty: true, mutationId: id() }
        : { ...draft(part.text, part.images), id: part.id });
    });
  }
  function operations(notes) {
    return notes.filter(note => note.dirty).map(note => {
      const deleted = note.deleted || isBlank(note.text, note.images);
      return { id: note.id, text: deleted ? "" : note.text, images: deleted ? [] : [...(note.images || [])], baseVersion: note.version, deleted, mutationId: note.mutationId };
    });
  }
  function batch(operations) {
    const encoder = new TextEncoder();
    // Include the JSON envelope and commas in the API's byte limit.
    let bytes = encoder.encode(JSON.stringify({ requestId: '0'.repeat(36), operations: [] })).byteLength;
    let length = 0;
    const result = [];
    for (const operation of operations) {
      const wire = { ...operation, images: (operation.images || []).map(src => CopyNotesImages.byteLength(src) > CopyNotesImages.inlineBytes
        ? CopyNotesImages.referencePrefix + '0'.repeat(36) : src) };
      const size = encoder.encode(JSON.stringify(wire)).byteLength + (result.length ? 1 : 0);
      if (result.length === 200 || length + operation.text.length > 1000000 || bytes + size > 2 * 1024 * 1024) break;
      result.push(operation);
      length += operation.text.length;
      bytes += size;
    }
    return result;
  }
  function sort(notes) {
    return notes.sort((a, b) => (a.version ? a.order : Infinity) - (b.version ? b.order : Infinity) || (a.position || 0) - (b.position || 0));
  }
  function merge(local, incoming, sent = []) {
    const remote = new Map(incoming.map(note => [note.id, note]));
    const posted = new Map(sent.map(note => [note.id, note]));
    const result = [];
    let copies = 0;
    let deletions = 0;
    const preserved = [];
    for (const note of local) {
      const latest = remote.get(note.id);
      remote.delete(note.id);
      if (!note.dirty) { if (latest) result.push(clean(latest)); continue; }
      if (!latest) {
        if (note.version === 0) result.push(note);
        else if (!note.deleted && !isBlank(note.text, note.images)) { const copy = draft(note.text, note.images); result.push(copy); preserved.push([note.id, copy.id]); copies++; }
        continue;
      }
      if (latest.deleted) {
        result.push(clean(latest));
        if (!note.deleted && !isBlank(note.text, note.images)) {
          const copy = draft(note.text, note.images);
          result.push(copy); preserved.push([note.id, copy.id]); copies++;
        }
        continue;
      }
      if (latest.mutationId === note.mutationId || !note.deleted && CopyNotesImages.equalNote(note, latest)) {
        result.push(clean(latest));
      } else if (latest.mutationId === posted.get(note.id)?.mutationId || latest.mutationId === note.pendingMutationId) {
        // The user continued editing while their previous snapshot was uploading.
        const { pendingMutationId, ...current } = note;
        result.push({ ...current, version: latest.version, order: latest.order, position: latest.position, syncedAt: latest.syncedAt, originalText: latest.text, originalImages: [...(latest.images || [])] });
      } else if (latest.version === note.version) {
        result.push(note);
      } else {
        result.push(clean(latest));
        if (!note.deleted && !isBlank(note.text, note.images)) { const copy = draft(note.text, note.images); result.push(copy); preserved.push([note.id, copy.id]); copies++; }
        else deletions++;
      }
    }
    for (const note of remote.values()) result.push(clean(note));
    return { notes: sort(result), copies, deletions, preserved };
  }
  function update(note, text, forceDirty = false, images = note.images || []) {
    if (note.text === text && CopyNotesImages.equal(note.images, images)) return;
    note.text = text;
    note.images = [...images];
    note.dirty = forceDirty || note.version === 0 || note.deleted || text !== note.originalText || !CopyNotesImages.equal(images, note.originalImages);
    note.mutationId = id();
  }
  function remove(note) {
    note.deleted = true;
    note.dirty = true;
    note.mutationId = id();
  }
  function compactBlank(notes, inFlightIds = new Set(), onlyIds = null) {
    return notes.flatMap(note => {
      if (note.deleted || !isBlank(note.text, note.images) || onlyIds && !onlyIds.has(note.id)) return [note];
      if (note.version === 0 && !inFlightIds.has(note.id) && !note.pendingMutationId) return [];
      return [{ ...note, deleted: true, dirty: true, mutationId: id() }];
    });
  }
  return Object.freeze({ draft, operations, batch, sort, merge, update, remove, isBlank, compactBlank, normalizeLegacy });
})();
