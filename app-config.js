"use strict";

globalThis.CopyNotesConfig = (() => {
  const previews = ['http://localhost:5500', 'http://127.0.0.1:5500', 'http://[::1]:5500'];
  const preview = previews.includes(globalThis.location?.origin);
  return Object.freeze({ apiBase: preview ? 'https://copynotes-bjx.pages.dev' : '', persistSession: preview });
})();
