"use strict";

globalThis.CopyNotesDeviceStorage = (() => {
  const key = 'copynotes.notes.v2';
  const legacyKey = 'copynotes.notes.v1';
  const draft = (text = '') => ({ id: crypto.randomUUID(), text });
  const clone = notes => notes.map(note => ({ ...note }));

  function create(storage, onError = () => {}) {
    function read() {
      try {
        const value = JSON.parse(storage.getItem(key) || 'null');
        if (Array.isArray(value) && value.every(note => note && typeof note.id === 'string' && typeof note.text === 'string')
          && new Set(value.map(note => note.id)).size === value.length) return value;
        const legacy = JSON.parse(storage.getItem(legacyKey) || 'null');
        if (Array.isArray(legacy) && legacy.every(text => typeof text === 'string')) {
          // Deterministic IDs let tabs migrating the same saved notes agree.
          return legacy.map((text, index) => ({ id: 'legacy-' + index, text }));
        }
        return null;
      } catch { onError(); return null; }
    }

    let baseline = read();
    const initial = baseline === null ? [draft()] : baseline.filter(note => note.text.trim());
    baseline ||= [];

    function save(local) {
      const latest = read() || clone(baseline);
      const original = new Map(baseline.map(note => [note.id, note]));
      const current = new Map(local.map(note => [note.id, note]));
      const merged = new Map(latest.map(note => [note.id, note]));
      const preserved = [];
      for (const note of local) {
        const before = original.get(note.id);
        if (before && before.text === note.text) continue;
        const other = merged.get(note.id);
        if (before && (!other || other.text !== before.text && other.text !== note.text)) {
          // Preserve both edits, including edits made while another tab deletes.
          const copy = draft(note.text);
          merged.set(copy.id, copy);
          preserved.push([note.id, copy.id]);
        } else merged.set(note.id, { ...note });
      }
      for (const before of baseline) {
        if (!current.has(before.id) && merged.get(before.id)?.text === before.text) merged.delete(before.id);
      }
      const notes = [...merged.values()];
      try {
        const serialized = JSON.stringify(notes);
        if (storage.getItem(key) !== serialized) storage.setItem(key, serialized);
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
