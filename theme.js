"use strict";

// Preferences belong to this browser and never enter a note or API request.
// Load before the stylesheet so the saved palette is applied before painting.
globalThis.CopyNotesTheme = (() => {
  const key = 'copynotes.settings.v1';
  const colors = { light: '#fafaf9', dark: '#181d21', sepia: '#f4eddf', blue: '#eaf2fa', mint: '#eaf4ee', rose: '#f8edf0', lavender: '#f0edf8', navy: '#121d30' };
  const choices = [...Object.keys(colors), 'system'];
  const darkThemes = new Set(['dark', 'navy']);
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
    const root = document.documentElement;
    const scheme = darkThemes.has(theme) ? 'dark' : 'light';
    root.dataset.theme = theme;
    // Home Screen apps sample the document background for native chrome.
    // Set real color values too, rather than relying only on CSS variables.
    root.style.backgroundColor = colors[theme];
    root.style.colorScheme = scheme;
    if (document.body) document.body.style.backgroundColor = colors[theme];
    // Modal dialogs live above the document and its status-bar layer. Paint
    // their viewport-edge layers too so an open overlay cannot mask a change.
    for (const selector of ['.system-bar-background', '.dialog-system-bar']) {
      for (const layer of document.querySelectorAll?.(selector) || []) layer.style.backgroundColor = colors[theme];
    }
    const themeColor = document.querySelector('meta[name="theme-color"]');
    themeColor?.setAttribute('content', colors[theme]);
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', scheme);
    // Reattach after changing a color: installed iOS apps can retain the old
    // native tint when only the content attribute of an existing tag changes.
    if (themeColor?.parentNode) themeColor.parentNode.appendChild(themeColor);
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
  document.addEventListener('DOMContentLoaded', apply, { once: true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') apply(); });
  globalThis.addEventListener?.('pageshow', apply);
  globalThis.addEventListener?.('storage', event => {
    if (event.storageArea && event.storageArea !== storage || event.key !== key && event.key !== null) return;
    preference = event.key === null ? 'light' : parse(event.newValue);
    apply();
  });
  apply();
  return Object.freeze({ key, choices: Object.freeze(choices), get: () => preference, set, subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  } });
})();
