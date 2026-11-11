"use strict";

globalThis.CopyNotesConfig = (() => {
  const previews = ['http://localhost:5500', 'http://127.0.0.1:5500', 'http://[::1]:5500'];
  return Object.freeze({ apiBase: previews.includes(globalThis.location?.origin) ? 'https://copynotes-bjx.pages.dev' : '' });
})();
