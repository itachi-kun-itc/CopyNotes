"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createDatabase } = require("./lib/sqlite-adapter.cjs");
const host = "127.0.0.1";
const port = Number(process.env.COPYNOTES_PORT || process.env.PORT) || 4173;
const dataDirectory = path.join(__dirname, ".local-data");
fs.mkdirSync(dataDirectory, { recursive: true });
const database = createDatabase(path.join(dataDirectory, "copynotes.sqlite"));
const api = import("./lib/cloud-api.mjs");
const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/app-config.js", ["app-config.js", "text/javascript; charset=utf-8"]],
  ["/syntax.js", ["syntax.js", "text/javascript; charset=utf-8"]],
  ["/links.js", ["links.js", "text/javascript; charset=utf-8"]],
  ["/code-editor.js", ["code-editor.js", "text/javascript; charset=utf-8"]],
  ["/sharing.js", ["sharing.js", "text/javascript; charset=utf-8"]],
  ["/manifest.json", ["manifest.json", "application/manifest+json; charset=utf-8"]],
  ["/assets/icon.svg", ["assets/icon.svg", "image/svg+xml"]],
]);

http.createServer(async (request, response) => {
  let url;
  try { url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`); }
  catch { response.writeHead(400).end("Bad Request"); return; }
  if (url.pathname.startsWith("/api/")) {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { response.writeHead(413).end("Too Large"); return; }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      headers.set("cf-connecting-ip", request.socket.remoteAddress || "local");
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const webRequest = new Request(url, { method: request.method, headers, ...(body ? { body } : {}) });
      const result = await (await api).handleApi(webRequest, { DB: database });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      console.error("Local API error:", error);
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "共有機能に接続できませんでした" }));
    }
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end("Method Not Allowed"); return;
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { response.writeHead(400).end("Bad Request"); return; }
  const file = files.get(pathname);
  if (!file) { response.writeHead(404).end("Not Found"); return; }
  fs.readFile(path.join(__dirname, file[0]), (error, content) => {
    if (error) { response.writeHead(500).end("Server Error"); return; }
    response.writeHead(200, {
      "Content-Type": file[1], "Content-Length": content.length,
      "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : content);
  });
}).listen(port, host, () => console.log(`CopyNotes: http://${host}:${port}`));
