"use strict";

globalThis.CopyNotesSharing = (() => {
  const id = () => crypto.randomUUID();
  const isBlank = text => text.trim().length === 0;
  function draft(text = "") {
    return { id: id(), text, version: 0, order: null, position: 0, syncedAt: null, deleted: false, dirty: true, originalText: "", mutationId: id() };
  }
  function clean(note) { return { ...note, dirty: false, originalText: note.text }; }
  function operations(notes) {
    return notes.filter(note => note.dirty).map(note => {
      const deleted = note.deleted || isBlank(note.text);
      return { id: note.id, text: deleted ? "" : note.text, baseVersion: note.version, deleted, mutationId: note.mutationId };
    });
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
        else if (!note.deleted && !isBlank(note.text)) { const copy = draft(note.text); result.push(copy); preserved.push([note.id, copy.id]); copies++; }
        continue;
      }
      if (latest.deleted) {
        result.push(clean(latest));
        if (!note.deleted && !isBlank(note.text)) {
          const copy = draft(note.text);
          result.push(copy); preserved.push([note.id, copy.id]); copies++;
        }
        continue;
      }
      if (latest.mutationId === note.mutationId || latest.deleted && note.deleted) {
        result.push(clean(latest));
      } else if (latest.mutationId === posted.get(note.id)?.mutationId || latest.mutationId === note.pendingMutationId) {
        // The user continued editing while their previous snapshot was uploading.
        const { pendingMutationId, ...current } = note;
        result.push({ ...current, version: latest.version, order: latest.order, position: latest.position, syncedAt: latest.syncedAt, originalText: latest.text });
      } else if (latest.version === note.version) {
        result.push(note);
      } else {
        result.push(clean(latest));
        if (!note.deleted && !isBlank(note.text)) { const copy = draft(note.text); result.push(copy); preserved.push([note.id, copy.id]); copies++; }
        else deletions++;
      }
    }
    for (const note of remote.values()) result.push(clean(note));
    return { notes: sort(result), copies, deletions, preserved };
  }
  function update(note, text, forceDirty = false) {
    if (note.text === text) return;
    note.text = text;
    note.dirty = forceDirty || note.version === 0 || note.deleted || text !== note.originalText;
    note.mutationId = id();
  }
  function remove(note) {
    note.deleted = true;
    note.dirty = true;
    note.mutationId = id();
  }
  function compactBlank(notes, inFlightIds = new Set(), onlyIds = null) {
    return notes.flatMap(note => {
      if (note.deleted || !isBlank(note.text) || onlyIds && !onlyIds.has(note.id)) return [note];
      if (note.version === 0 && !inFlightIds.has(note.id) && !note.pendingMutationId) return [];
      return [{ ...note, deleted: true, dirty: true, mutationId: id() }];
    });
  }
  return Object.freeze({ draft, operations, sort, merge, update, remove, isBlank, compactBlank });
})();
