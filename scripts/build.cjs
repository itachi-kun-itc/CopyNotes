"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist");
// The upload contains only public assets. Databases, sessions and source stay out.
const files = ["index.html", "styles.css", "app.js", "app-config.js", "syntax.js", "links.js", "note-limits.js", "code-editor.js", "sharing.js", "auto-sync.js", "touch-notes.js", "workspace-tabs.js", "manifest.json", "assets/icon.svg", "_headers", "_routes.json", ".nojekyll"];
if (path.resolve(output) !== path.join(root, "dist")) throw new Error("Unexpected output directory");
if (fs.existsSync(output)) fs.rmSync(output, { recursive: true, force: true });
for (const file of files) {
  const destination = path.join(output, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, file), destination);
}
if (process.argv.includes("--github-pages")) {
  fs.writeFileSync(path.join(output, "app-config.js"), '"use strict";\nglobalThis.CopyNotesConfig = Object.freeze({ apiBase: "https://copynotes-bjx.pages.dev" });\n');
}
console.log(`Built ${files.length} public files in dist/ (${process.argv.includes("--github-pages") ? "GitHub Pages" : "Cloudflare / local"})`);
