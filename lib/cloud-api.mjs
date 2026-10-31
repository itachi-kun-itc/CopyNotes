const SESSION_SECONDS = 60 * 60 * 24 * 30;
const PAGES_SESSION_SECONDS = 15 * 60;
const PAGES_ORIGIN = "https://itachi-kun-itc.github.io";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ID = /^[a-zA-Z0-9_-]{1,80}$/;

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
function isPagesRequest(request) { return request.headers.get("origin") === PAGES_ORIGIN && new URL(request.url).origin !== PAGES_ORIGIN; }
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

async function currentSession(request, db) {
  const token = sessionToken(request);
  if (!token) return null;
  return db.prepare("SELECT sessions.room_id FROM sessions INNER JOIN login_codes ON login_codes.room_id = sessions.room_id WHERE token_hash = ? AND expires_at > ?").bind(await hash(token), Date.now()).first();
}

function notesQuery(db, room) {
  return db.prepare("SELECT id, content, version, sync_order, sync_position, synced_at, deleted, mutation_id FROM shared_notes WHERE room_id = ? ORDER BY sync_order ASC, sync_position ASC, id ASC").bind(room);
}
function serializeNotes(rows) {
  return rows.map(row => ({ id: row.id, text: row.content, version: row.version, order: row.sync_order, position: row.sync_position, syncedAt: row.synced_at, deleted: Boolean(row.deleted), mutationId: row.mutation_id }));
}

async function authenticate(request, db) {
  if (request.method === "GET") {
    const session = await currentSession(request, db);
    return json({ authenticated: Boolean(session), roomId: session?.room_id || null });
  }
  if (request.method === "DELETE") {
    const token = sessionToken(request);
    if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hash(token)).run();
    return json({ authenticated: false }, 200, isPagesRequest(request) ? {} : { "Set-Cookie": cookieHeader(request, "", 0) });
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
  const pages = isPagesRequest(request);
  const duration = pages ? PAGES_SESSION_SECONDS : SESSION_SECONDS;
  const statements = [db.prepare("INSERT INTO sessions(token_hash, room_id, expires_at) SELECT ?, room_id, ? FROM login_codes WHERE code_hash = ? AND room_id = ?").bind(tokenHash, now + duration * 1000, codeHash, room)];
  const previous = sessionToken(request);
  if (previous) statements.push(db.prepare("DELETE FROM sessions WHERE token_hash = ? AND EXISTS(SELECT 1 FROM sessions WHERE token_hash = ?)").bind(await hash(previous), tokenHash));
  statements.push(db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now));
  const results = await db.batch(statements);
  if (!results[0].meta.changes) throw new ApiError(401, "無効なログイン番号です。発行済みの番号を入力してください");
  return json({ authenticated: true, roomId: room, ...(pages ? { sessionToken: token, expiresIn: duration } : {}) }, 200, pages ? {} : { "Set-Cookie": cookieHeader(request, token) });
}

async function sharedNotes(request, db) {
  const session = await currentSession(request, db);
  if (!session) throw new ApiError(401, "共有するにはログインしてください");
  if (request.method === "GET") {
    const { results } = await notesQuery(db, session.room_id).all();
    return json({ notes: serializeNotes(results) });
  }
  if (request.method !== "POST") return json({ error: "この操作は利用できません" }, 405, { Allow: "GET, POST" });
  const { requestId, operations } = await readJSON(request);
  if (typeof requestId !== "string" || !ID.test(requestId) || !Array.isArray(operations) || operations.length === 0 || operations.length > 200) throw new ApiError(400, "同期する内容を確認してください（一度に200件まで）");
  const ids = new Set();
  let total = 0;
  for (const operation of operations) {
    if (!operation || typeof operation !== "object" || typeof operation.id !== "string" || !ID.test(operation.id)
      || typeof operation.mutationId !== "string" || !ID.test(operation.mutationId) || ids.has(operation.id)
      || !Number.isSafeInteger(operation.baseVersion) || operation.baseVersion < 0
      || typeof operation.text !== "string" || operation.text.length > 100000 || typeof operation.deleted !== "boolean") throw new ApiError(400, "同期するメモの形式を確認してください");
    ids.add(operation.id);
    total += operation.text.length;
  }
  if (total > 1000000) throw new ApiError(413, "同期する内容が大きすぎます");
  const room = session.room_id;
  const now = Date.now();
  const statements = [db.prepare("INSERT OR IGNORE INTO sync_events(room_id, request_id, synced_at) VALUES(?, ?, ?)").bind(room, requestId, now)];
  operations.forEach((operation, index) => {
    if (operation.baseVersion === 0) {
      statements.push(db.prepare("INSERT INTO shared_notes(room_id, id, content, version, sync_order, sync_position, synced_at, deleted, mutation_id) VALUES(?, ?, ?, 1, (SELECT sequence FROM sync_events WHERE room_id = ? AND request_id = ?), ?, ?, ?, ?) ON CONFLICT(room_id, id) DO NOTHING")
        .bind(room, operation.id, operation.deleted ? "" : operation.text, room, requestId, index, now, operation.deleted ? 1 : 0, operation.mutationId));
    } else {
      statements.push(db.prepare("UPDATE shared_notes SET content = ?, version = version + 1, sync_order = (SELECT sequence FROM sync_events WHERE room_id = ? AND request_id = ?), sync_position = ?, synced_at = ?, deleted = ?, mutation_id = ? WHERE room_id = ? AND id = ? AND version = ? AND mutation_id <> ?")
        .bind(operation.deleted ? "" : operation.text, room, requestId, index, now, operation.deleted ? 1 : 0, operation.mutationId, room, operation.id, operation.baseVersion, operation.mutationId));
    }
  });
  statements.push(notesQuery(db, room));
  const results = await db.batch(statements);
  const notes = serializeNotes(results.at(-1).results);
  const versions = new Map(notes.map(note => [note.id, note.mutationId]));
  const conflicts = operations.filter(operation => versions.get(operation.id) !== operation.mutationId).map(operation => operation.id);
  return json({ notes, conflicts });
}

async function routeApi(request, env) {
  try {
    if (!env.DB) throw new ApiError(503, "共有機能の保存先がまだ設定されていません");
    if (!["GET", "HEAD"].includes(request.method)) {
      const origin = request.headers.get("origin");
      if ((origin && origin !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") && !isPagesRequest(request)) throw new ApiError(403, "このページからの操作は許可されていません");
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/auth") return await authenticate(request, env.DB);
    if (pathname === "/api/notes") return await sharedNotes(request, env.DB);
    return json({ error: "見つかりません" }, 404);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    console.error("CopyNotes API error:", error);
    return json({ error: "共有データに接続できませんでした。時間をおいてもう一度お試しください" }, 500);
  }
}

export async function handleApi(request, env) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin && origin !== PAGES_ORIGIN) return json({ error: "このページからの操作は許可されていません" }, 403);
  const pages = isPagesRequest(request);
  let response;
  if (request.method === "OPTIONS") {
    if (!pages || !["GET", "POST", "DELETE"].includes(request.headers.get("access-control-request-method"))) return json({ error: "この操作は利用できません" }, 403);
    response = new Response(null, { status: 204 });
  } else response = await routeApi(request, env);
  if (!pages) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", PAGES_ORIGIN);
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Max-Age", "300");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}
