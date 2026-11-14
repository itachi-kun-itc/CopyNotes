"use strict";

const crypto = require("node:crypto");

function validateCode(code) {
  if (typeof code !== "string" || !/^(?:[0-9]{5}|G[0-9]{4})$/.test(code)) throw new Error('通常番号は半角数字5桁、グループ番号はG＋半角数字4桁で指定してください');
  return code;
}
function codeHash(code) {
  return crypto.createHash("sha256").update(`copynotes:room:${validateCode(code)}`).digest("hex");
}
function issue(code, workspace = code?.startsWith('G') ? 'group' : 'shared') {
  if (!['shared', 'group'].includes(workspace)) throw new Error('番号の種類を確認してください');
  code ??= workspace === 'group' ? 'G' + String(crypto.randomInt(10000)).padStart(4, '0') : String(crypto.randomInt(100000)).padStart(5, '0');
  validateCode(code);
  if (code.startsWith('G') !== (workspace === 'group')) throw new Error('グループ番号はG＋半角数字4桁で指定してください');
  const roomId = crypto.randomUUID();
  return { code: validateCode(code), roomId, workspace, statements: [{
    sql: "INSERT INTO login_codes(code_hash, room_id, issued_at, workspace) VALUES(?, ?, ?, ?) ON CONFLICT(code_hash) DO NOTHING RETURNING room_id, issued_at, workspace",
    values: [codeHash(code), roomId, Date.now(), workspace],
  }] };
}
function remove(code) {
  const hash = codeHash(code);
  return { code, statements: [
    { sql: "DELETE FROM sessions WHERE room_id IN (SELECT room_id FROM login_codes WHERE code_hash = ?) OR room_id = ?", values: [hash, hash] },
    { sql: "DELETE FROM login_codes WHERE code_hash = ?", values: [hash] },
  ] };
}
function removeAll() {
  return { statements: [
    { sql: "DELETE FROM sessions", values: [] },
    { sql: "DELETE FROM login_codes", values: [] },
  ] };
}
function status(code) {
  return { code, statements: [code === undefined
    ? { sql: "SELECT (SELECT COUNT(*) FROM login_codes) AS issued_codes, (SELECT COUNT(*) FROM sessions) AS sessions", values: [] }
    : { sql: "SELECT issued_at, workspace FROM login_codes WHERE code_hash = ?", values: [codeHash(code)] }],
  };
}
function prepare(db, plan) {
  return plan.statements.map(statement => db.prepare(statement.sql).bind(...statement.values));
}
function renderSQL(plan) {
  return plan.statements.map(statement => {
    let index = 0;
    const sql = statement.sql.replace(/\?/g, () => {
      const value = statement.values[index++];
      if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
      if (typeof value === "string") return "'" + value.replace(/'/g, "''") + "'";
      throw new Error("Invalid SQL parameter");
    });
    if (index !== statement.values.length) throw new Error("Invalid SQL parameter count");
    return sql + ";";
  }).join("\n");
}

module.exports = { validateCode, codeHash, issue, remove, removeAll, status, prepare, renderSQL };
