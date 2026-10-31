"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const admin = require("../lib/login-admin.cjs");
const root = path.resolve(__dirname, "..");

function wranglerBinary() {
  for (const entry of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.resolve(entry, "../wrangler/package.json");
    if (!fs.existsSync(candidate)) continue;
    const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
    if (pkg.name === "wrangler") return path.resolve(path.dirname(candidate), typeof pkg.bin === "string" ? pkg.bin : pkg.bin.wrangler);
  }
  throw new Error("npm run login:issue / login:delete / login:delete-all / login:status から実行してください");
}

function execute(plan, local) {
  if (local) {
    const { createDatabase } = require("../lib/sqlite-adapter.cjs");
    const directory = path.join(root, ".local-data");
    fs.mkdirSync(directory, { recursive: true });
    const db = createDatabase(path.join(directory, "copynotes.sqlite"));
    try { return db.batch(admin.prepare(db, plan)); }
    finally { db.close(); }
  }
  // Pass SQL directly as a process argument: no shell and no credential files.
  const result = spawnSync(process.execPath, [wranglerBinary(), "d1", "execute", "copynotes-db", "--remote", "--command", admin.renderSQL(plan), "--json"], {
    cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "Cloudflareに接続できませんでした").trim());
  return JSON.parse(result.stdout);
}

function main(args) {
  const [action, ...options] = args;
  const local = options.includes("--local");
  const json = options.includes("--json");
  const unknown = options.find(option => option.startsWith("--") && !["--local", "--json"].includes(option));
  const codes = options.filter(option => !option.startsWith("--"));
  if (unknown || codes.length > 1 || !["issue", "delete", "delete-all", "status"].includes(action)) throw new Error("使い方: issue [5桁番号] / delete 5桁番号 / delete-all / status [5桁番号] [--local]");
  const code = codes[0];
  if (action === "delete" && code === undefined) throw new Error("削除する5桁の番号を指定してください");
  if (action === "delete-all" && code !== undefined) throw new Error("delete-all に番号は指定できません");
  const plan = action === "issue" ? admin.issue(code) : action === "delete" ? admin.remove(code) : action === "delete-all" ? admin.removeAll() : admin.status(code);
  const results = execute(plan, local);
  const rows = results.flatMap(result => result.results || []);
  let output;
  if (action === "issue") {
    if (!rows.some(row => row.room_id === plan.roomId)) throw new Error("その番号はすでに発行済みです。別の番号を指定してください");
    output = { action, code: plan.code, target: local ? "local" : "cloudflare", message: "ログイン番号を発行しました" };
  } else if (action === "status") {
    output = code === undefined ? { action, ...rows[0] } : { action, code, issued: rows.length > 0 };
  } else output = { action, ...(code === undefined ? {} : { code }), message: action === "delete-all" ? "すべての番号とログイン状態を削除しました" : "番号とログイン状態を削除しました" };
  if (json) process.stdout.write(JSON.stringify(output) + "\n");
  else if (action === "issue") console.log(`${output.message}: ${output.code}${local ? "（ローカル専用）" : ""}`);
  else if (action === "status") console.log(code === undefined ? `発行済み番号: ${output.issued_codes}件 / ログイン状態: ${output.sessions}件` : `${code}: ${output.issued ? "発行済み" : "未発行または削除済み"}`);
  else console.log(output.message);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main, execute };
