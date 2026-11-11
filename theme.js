"use strict";

// Preferences belong to this browser and never enter a note or API request.
// Load before the stylesheet so the saved palette is applied before painting.
globalThis.CopyNotesTheme = (() => {
  const key = 'copynotes.settings.v1';
  const choices = ['light', 'dark', 'sepia', 'system'];
  const colors = { light: '#fafaf9', dark: '#181d21', sepia: '#f4eddf' };
  const listeners = new Set();
  const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  let storage;
  try { storage = globalThis.localStorage; } catch { /* Session-only settings. */ }
  function parse(value) {
    try {
      const theme = JSON.parse(value)?.theme;
      return choices.includes(theme) ? theme : 'light';
    } catch { return 'light'; }
  }
  let preference = 'light';
  try { preference = parse(storage?.getItem(key)); } catch { /* Use the default. */ }
  function apply() {
    const theme = preference === 'system' ? media?.matches ? 'dark' : 'light' : preference;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors[theme]);
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme === 'dark' ? 'dark' : 'light');
    for (const listener of listeners) listener(preference);
  }
  function set(value) {
    if (!choices.includes(value)) return false;
    preference = value;
    apply();
    try {
      if (!storage) return false;
      storage.setItem(key, JSON.stringify({ theme: preference }));
      return true;
    } catch { return false; }
  }
  media?.addEventListener('change', () => { if (preference === 'system') apply(); });
  globalThis.addEventListener?.('storage', event => {
    if (event.storageArea && event.storageArea !== storage || event.key !== key && event.key !== null) return;
    preference = event.key === null ? 'light' : parse(event.newValue);
    apply();
  });
  apply();
  return Object.freeze({ key, get: () => preference, set, subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  } });
})();
