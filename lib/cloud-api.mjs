import '../note-limits.js';
import '../note-images.js';
import { imageApi } from './image-api.mjs';

const noteLimits = globalThis.CopyNotesLimits;
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const TOKEN_SESSION_SECONDS = 15 * 60;
const PAGES_ORIGIN = "https://itachi-kun-itc.github.io";
const CLIENT_ORIGINS = new Set([PAGES_ORIGIN, 'http://localhost:5500', 'http://127.0.0.1:5500', 'http://[::1]:5500']);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ID = /^[a-zA-Z0-9_-]{1,160}$/;
const BLANK_CONTENT = "trim(content, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) = ''";

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  } });
}

async function hash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function cookieName(request) { return new URL(request.url).protocol === "https:" ? "__Host-cn_session" : "cn_session"; }
function isTokenRequest(request) {
  const origin = request.headers.get('origin');
  return CLIENT_ORIGINS.has(origin) && new URL(request.url).origin !== origin;
}
function cookieHeader(request, token, maxAge = SESSION_SECONDS) {
  return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
function sessionToken(request) {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) return /^Bearer ([a-f0-9]{64})$/i.exec(authorization)?.[1].toLowerCase() || "";
  const cookie = (request.headers.get("cookie") || "").split(";").map(item => item.trim()).find(item => item.startsWith(`${cookieName(request)}=`));
  const token = cookie?.slice(cookie.indexOf("=") + 1) || "";
  return /^[a-f0-9]{64}$/.test(token) ? token : "";
}

async function readJSON(request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ApiError(415, "JSON形式で送信してください");
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw new ApiError(413, "同期する内容が大きすぎます");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "入力内容を確認してください");
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new ApiError(413, "同期する内容が大きすぎます"); }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(buffer)); }
  catch { throw new ApiError(400, "入力内容を確認してください"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "入力内容を確認してください");
  return body;
}

async function currentSession(request, db, checkRoom = false) {
  const token = sessionToken(request);
  if (!token) return null;
  const session = await db.prepare("SELECT sessions.room_id FROM sessions INNER JOIN login_codes ON login_codes.room_id = sessions.room_id WHERE token_hash = ? AND expires_at > ?").bind(await hash(token), Date.now()).first();
  // Cookies are shared by tabs, but each tab's drafts belong to its original room.
  if (checkRoom && session && request.headers.get("X-CopyNotes-Room") !== session.room_id) {
    throw new ApiError(401, "別のタブでログイン先が変更されました。再度ログインしてください");
  }
  return session;
}

function notesQuery(db, room) {
  return db.prepare("SELECT id, content, images, version, sync_order, sync_position, synced_at, deleted, mutation_id FROM shared_notes WHERE room_id = ? UNION ALL SELECT id, '' AS content, '[]' AS images, version, sync_order, sync_position, synced_at, 1 AS deleted, mutation_id FROM shared_note_deletions WHERE room_id = ? ORDER BY sync_order ASC, sync_position ASC, id ASC").bind(room, room);
}
function removeBlankNotes(db, room) {
  return [
    db.prepare(`INSERT INTO shared_note_deletions(room_id, id, version, sync_order, sync_position, synced_at, mutation_id) SELECT room_id, id, version + CASE WHEN deleted = 0 THEN 1 ELSE 0 END, sync_order, sync_position, synced_at, mutation_id FROM shared_notes WHERE room_id = ? AND (deleted = 1 OR (${BLANK_CONTENT} AND images = '[]')) ON CONFLICT(room_id, id) DO NOTHING`).bind(room),
    db.prepare("DELETE FROM shared_notes WHERE room_id = ? AND EXISTS(SELECT 1 FROM shared_note_deletions d WHERE d.room_id = shared_notes.room_id AND d.id = shared_notes.id)").bind(room),
  ];
}
function serializeNotes(rows) {
  return rows.map(row => ({ id: row.id, text: row.content, images: JSON.parse(row.images), version: row.version, order: row.sync_order, position: row.sync_position, syncedAt: row.synced_at, deleted: Boolean(row.deleted), mutationId: row.mutation_id }));
}

function orderQuery(db, room) {
  return db.prepare('SELECT ids, revision FROM shared_note_orders WHERE room_id = ?').bind(room);
}
function serializeOrder(row) { return row ? { ids: JSON.parse(row.ids), revision: row.revision } : { ids: [], revision: 0 }; }

async function sharedNoteOrder(request, db) {
  const session = await currentSession(request, db, true);
  if (!session) throw new ApiError(401, '共有するにはログインしてください');
  if (request.method !== 'POST') return json({ error: 'この操作は利用できません' }, 405, { Allow: 'POST' });
  const { ids, mutationId } = await readJSON(request);
  if (!Array.isArray(ids) || ids.length > 10000 || !ids.every(id => typeof id === 'string' && ID.test(id))
    || new Set(ids).size !== ids.length || typeof mutationId !== 'string' || !ID.test(mutationId)) {
    throw new ApiError(400, '並べ替えるメモの形式を確認してください');
  }
  const room = session.room_id;
  // Reuse the request sequence so retries cannot overwrite a newer order.
  const requestId = 'note-order:' + mutationId;
  const results = await db.batch([
    db.prepare('INSERT OR IGNORE INTO sync_events(room_id, request_id, synced_at) VALUES(?, ?, ?)').bind(room, requestId, Date.now()),
    db.prepare(`INSERT INTO shared_note_orders(room_id, ids, revision)
      SELECT ?, ?, sequence FROM sync_events WHERE room_id = ? AND request_id = ?
      ON CONFLICT(room_id) DO UPDATE SET ids = excluded.ids, revision = excluded.revision
      WHERE shared_note_orders.revision < excluded.revision`).bind(room, JSON.stringify(ids), room, requestId),
    orderQuery(db, room),
  ]);
  return json({ noteOrder: serializeOrder(results.at(-1).results[0]) });
}

async function authenticate(request, db) {
  if (request.method === "GET") {
    const session = await currentSession(request, db);
    return json({ authenticated: Boolean(session), roomId: session?.room_id || null });
  }
  if (request.method === "DELETE") {
    await currentSession(request, db, true);
    const token = sessionToken(request);
    if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hash(token)).run();
    return json({ authenticated: false }, 200, isTokenRequest(request) ? {} : { "Set-Cookie": cookieHeader(request, "", 0) });
  }
  if (request.method !== "POST") return json({ error: "この操作は利用できません" }, 405, { Allow: "GET, POST, DELETE" });
  const body = await readJSON(request);
  if (typeof body.code !== "string" || !/^[0-9]{5}$/.test(body.code)) throw new ApiError(400, "ログイン番号は半角数字5桁で入力してください");
  const now = Date.now();
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const limit = await db.prepare("INSERT INTO login_limits(key, count, reset_at) VALUES(?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END, reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END RETURNING count")
    .bind(await hash(`login:${ip}`), now + 60000, now, now, now + 60000).first();
  if (limit.count > 10) return json({ error: "ログイン操作が多いため、1分ほど待ってから再度お試しください" }, 429, { "Retry-After": "60" });
  const codeHash = await hash(`copynotes:room:${body.code}`);
  const issued = await db.prepare("SELECT room_id FROM login_codes WHERE code_hash = ?").bind(codeHash).first();
  if (!issued) throw new ApiError(401, "無効なログイン番号です。発行済みの番号を入力してください");
  const room = issued.room_id;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
  const tokenHash = await hash(token);
  const tokenClient = isTokenRequest(request);
  const duration = tokenClient ? TOKEN_SESSION_SECONDS : SESSION_SECONDS;
  const statements = [db.prepare("INSERT INTO sessions(token_hash, room_id, expires_at) SELECT ?, room_id, ? FROM login_codes WHERE code_hash = ? AND room_id = ?").bind(tokenHash, now + duration * 1000, codeHash, room)];
  const previous = sessionToken(request);
  if (previous) statements.push(db.prepare("DELETE FROM sessions WHERE token_hash = ? AND EXISTS(SELECT 1 FROM sessions WHERE token_hash = ?)").bind(await hash(previous), tokenHash));
  statements.push(db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now));
  const results = await db.batch(statements);
  if (!results[0].meta.changes) throw new ApiError(401, "無効なログイン番号です。発行済みの番号を入力してください");
  return json({ authenticated: true, roomId: room, ...(tokenClient ? { sessionToken: token, expiresIn: duration } : {}) }, 200, tokenClient ? {} : { "Set-Cookie": cookieHeader(request, token) });
}

async function sharedNotes(request, db) {
  const session = await currentSession(request, db, true);
  if (!session) throw new ApiError(401, "共有するにはログインしてください");
  if (request.method === "GET") {
    const results = await db.batch([...removeBlankNotes(db, session.room_id), notesQuery(db, session.room_id), orderQuery(db, session.room_id)]);
    return json({ notes: serializeNotes(results.at(-2).results), noteOrder: serializeOrder(results.at(-1).results[0]) });
  }
  if (request.method !== "POST") return json({ error: "この操作は利用できません" }, 405, { Allow: "GET, POST" });
  const { requestId, operations } = await readJSON(request);
  if (typeof requestId !== "string" || !ID.test(requestId) || !Array.isArray(operations) || operations.length === 0 || operations.length > 200) throw new ApiError(400, "同期する内容を確認してください（一度に200件まで）");
  const ids = new Set();
  const referenced = new Set();
  let total = 0;
  for (const operation of operations) {
    if (!operation || typeof operation !== "object" || typeof operation.id !== "string" || !ID.test(operation.id)
      || typeof operation.mutationId !== "string" || !ID.test(operation.mutationId) || ids.has(operation.id)
      || !Number.isSafeInteger(operation.baseVersion) || operation.baseVersion < 0
      || typeof operation.text !== "string" || noteLimits.count(operation.text) > noteLimits.maxNoteLength || typeof operation.deleted !== "boolean") throw new ApiError(400, "同期するメモの形式を確認してください");
    const sources = operation.images;
    if (sources !== undefined && (!Array.isArray(sources) || sources.length > 1 || !sources.every(src => {
      const id = CopyNotesImages.referenceId(src);
      if (id) { referenced.add(id); return true; }
      return CopyNotesImages.valid([src]) && CopyNotesImages.byteLength(src) <= CopyNotesImages.inlineBytes;
    }))) throw new ApiError(400, "画像は1つのメモに1枚までです。画像の形式・サイズも確認してください");
    if (operation.text.length && sources?.length) throw new ApiError(400, "文字と画像は別々のメモにしてください");
    ids.add(operation.id);
    total += operation.text.length;
  }
  if (total > 1000000) throw new ApiError(413, "同期する内容が大きすぎます");
  const room = session.room_id;
  if (referenced.size) {
    const { results } = await db.prepare('SELECT id FROM shared_images WHERE room_id = ? AND complete = 1').bind(room).all();
    const ready = new Set(results.map(row => row.id));
    if ([...referenced].some(id => !ready.has(id))) throw new ApiError(400, '画像のアップロードが完了していません');
  }
  const now = Date.now();
  const statements = [db.prepare("INSERT OR IGNORE INTO sync_events(room_id, request_id, synced_at) VALUES(?, ?, ?)").bind(room, requestId, now), ...removeBlankNotes(db, room)];
  // Free image slots before adding replacements in the same atomic batch,
  // retaining the caller's original positions for synchronization order.
  const ordered = operations.map((operation, index) => ({ operation, index }));
  ordered.sort((a, b) => Number(Boolean(a.operation.images?.length)) - Number(Boolean(b.operation.images?.length)));
  ordered.forEach(({ operation, index }) => {
    const deleting = operation.deleted || CopyNotesImages.isBlank(operation);
    if (deleting) {
      if (operation.baseVersion === 0) {
        statements.push(db.prepare("INSERT INTO shared_note_deletions(room_id, id, version, sync_order, sync_position, synced_at, mutation_id) SELECT ?, ?, 1, (SELECT sequence FROM sync_events WHERE room_id = ? AND request_id = ?), ?, ?, ? WHERE NOT EXISTS(SELECT 1 FROM shared_notes WHERE room_id = ? AND id = ?) ON CONFLICT(room_id, id) DO NOTHING")
          .bind(room, operation.id, room, requestId, index, now, operation.mutationId, room, operation.id));
      } else {
        statements.push(db.prepare("INSERT INTO shared_note_deletions(room_id, id, version, sync_order, sync_position, synced_at, mutation_id) SELECT room_id, id, version + 1, (SELECT sequence FROM sync_events WHERE room_id = ? AND request_id = ?), ?, ?, ? FROM shared_notes WHERE room_id = ? AND id = ? AND version = ? AND mutation_id <> ? ON CONFLICT(room_id, id) DO NOTHING")
          .bind(room, requestId, index, now, operation.mutationId, room, operation.id, operation.baseVersion, operation.mutationId));
      }
      statements.push(db.prepare("DELETE FROM shared_notes WHERE room_id = ? AND id = ? AND EXISTS(SELECT 1 FROM shared_note_deletions WHERE room_id = ? AND id = ? AND mutation_id = ?)")
        .bind(room, operation.id, room, operation.id, operation.mutationId));
    } else if (operation.baseVersion === 0) {
      statements.push(db.prepare("INSERT INTO shared_notes(room_id, id, content, images, version, sync_order, sync_position, synced_at, deleted, mutation_id) SELECT ?, ?, ?, ?, 1, (SELECT sequence FROM sync_events WHERE room_id = ? AND request_id = ?), ?, ?, 0, ? WHERE NOT EXISTS(SELECT 1 FROM shared_note_deletions WHERE room_id = ? AND id = ?) ON CONFLICT(room_id, id) DO NOTHING")
        .bind(room, operation.id, operation.text, JSON.stringify(operation.images || []), room, requestId, index, now, operation.mutationId, room, operation.id));
    } else {
      statements.push(db.prepare("UPDATE shared_notes SET content = ?, images = ?, version = version + 1, sync_order = (SELECT sequence FROM sync_events WHERE room_id = ? AND request_id = ?), sync_position = ?, synced_at = ?, deleted = ?, mutation_id = ? WHERE room_id = ? AND id = ? AND version = ? AND mutation_id <> ?")
        .bind(operation.deleted ? "" : operation.text, JSON.stringify(operation.images || []), room, requestId, index, now, operation.deleted ? 1 : 0, operation.mutationId, room, operation.id, operation.baseVersion, operation.mutationId));
    }
  });
  statements.push(notesQuery(db, room), orderQuery(db, room));
  let results;
  try { results = await db.batch(statements); }
  catch (error) {
    if (String(error.message).includes('image_note_limit')) throw new ApiError(400, '共有の画像は3枚（3メモ分）までです');
    throw error;
  }
  const notes = serializeNotes(results.at(-2).results);
  const versions = new Map(notes.map(note => [note.id, note.mutationId]));
  const conflicts = operations.filter(operation => versions.get(operation.id) !== operation.mutationId).map(operation => operation.id);
  return json({ notes, conflicts, noteOrder: serializeOrder(results.at(-1).results[0]) });
}

async function routeApi(request, env) {
  try {
    if (!env.DB) throw new ApiError(503, "共有機能の保存先がまだ設定されていません");
    if (!["GET", "HEAD"].includes(request.method)) {
      const origin = request.headers.get("origin");
      if ((origin && origin !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") && !isTokenRequest(request)) throw new ApiError(403, "このページからの操作は許可されていません");
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/auth") return await authenticate(request, env.DB);
    if (pathname === "/api/notes") return await sharedNotes(request, env.DB);
    if (pathname === '/api/note-order') return await sharedNoteOrder(request, env.DB);
    if (pathname === '/api/images' || pathname.startsWith('/api/images/')) {
      const session = await currentSession(request, env.DB, true);
      if (!session) throw new ApiError(401, '共有するにはログインしてください');
      return await imageApi(request, env.DB, session.room_id, { readJSON, json, ApiError });
    }
    return json({ error: "見つかりません" }, 404);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    console.error("CopyNotes API error:", error);
    return json({ error: "共有データに接続できませんでした。時間をおいてもう一度お試しください" }, 500);
  }
}

export async function handleApi(request, env) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin && !CLIENT_ORIGINS.has(origin)) return json({ error: "このページからの操作は許可されていません" }, 403);
  const tokenClient = isTokenRequest(request);
  let response;
  if (request.method === "OPTIONS") {
    if (!tokenClient || !["GET", "POST", "DELETE"].includes(request.headers.get("access-control-request-method"))) return json({ error: "この操作は利用できません" }, 403);
    response = new Response(null, { status: 204 });
  } else response = await routeApi(request, env);
  if (!tokenClient) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CopyNotes-Room");
  headers.set("Access-Control-Max-Age", "300");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}
