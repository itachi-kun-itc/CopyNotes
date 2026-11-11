"use strict";

if (typeof require === 'function') require('./note-images.js');

globalThis.CopyNotesDeviceStorage = (() => {
  const key = 'copynotes.notes.v5';
  const legacyKey = 'copynotes.notes.v1';
  const draft = (text = '', images = []) => ({ id: crypto.randomUUID(), text, ...(images.length ? { images: [...images] } : {}) });
  const clone = notes => notes.map(note => ({ id: note.id, text: note.text, ...(note.images ? { images: [...note.images] } : {}) }));
  const equal = (a, b) => a && b && CopyNotesImages.equalNote(a, b);

  function create(storage, onError = () => {}) {
    function read() {
      try {
        const parse = name => storage.getNotes ? storage.getNotes(name) : JSON.parse(storage.getItem(name) || 'null');
        const value = parse(key) ?? parse('copynotes.notes.v4') ?? parse('copynotes.notes.v3') ?? parse('copynotes.notes.v2');
        if (Array.isArray(value) && value.every(note => note && typeof note.id === 'string' && typeof note.text === 'string' && CopyNotesImages.valid(note.images, 3))
          && new Set(value.map(note => note.id)).size === value.length) return clone(value).flatMap(CopyNotesImages.split);
        const legacy = JSON.parse(storage.getItem(legacyKey) || 'null');
        if (Array.isArray(legacy) && legacy.every(text => typeof text === 'string')) {
          // Deterministic IDs let tabs migrating the same saved notes agree.
          return legacy.map((text, index) => ({ id: 'legacy-' + index, text }));
        }
        return null;
      } catch { onError(); return null; }
    }

    let baseline = read();
    const initial = baseline === null ? [draft()] : baseline.filter(note => !CopyNotesImages.isBlank(note));
    baseline ||= [];

    function save(local) {
      const latest = read() || clone(baseline);
      const original = new Map(baseline.map(note => [note.id, note]));
      const current = new Map(local.map(note => [note.id, note]));
      const merged = new Map(latest.map(note => [note.id, note]));
      const preserved = [];
      for (const note of local) {
        const before = original.get(note.id);
        if (equal(before, note)) continue;
        const other = merged.get(note.id);
        if (before && (!other || !equal(other, before) && !equal(other, note))) {
          // Preserve both edits, including edits made while another tab deletes.
          const copy = draft(note.text, note.images);
          merged.set(copy.id, copy);
          preserved.push([note.id, copy.id]);
        } else merged.set(note.id, clone([note])[0]);
      }
      for (const before of baseline) {
        if (!current.has(before.id) && equal(merged.get(before.id), before)) merged.delete(before.id);
      }
      const notes = [...merged.values()];
      try {
        if (storage.setNotes) storage.setNotes(key, notes);
        else {
          const serialized = JSON.stringify(notes);
          if (storage.getItem(key) !== serialized) storage.setItem(key, serialized);
        }
        baseline = clone(notes);
      } catch {
        // Keep the previous baseline so a later save retries unsaved changes.
        onError();
      }
      return { notes, preserved };
    }

    return { load: () => clone(initial), save };
  }
  return Object.freeze({ key, draft, create });
})();
