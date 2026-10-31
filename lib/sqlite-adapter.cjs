"use strict";

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

function createDatabase(filename = ":memory:") {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  sqlite.exec("CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const migrations = path.join(__dirname, "../migrations");
  for (const name of fs.readdirSync(migrations).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
    if (sqlite.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name)) continue;
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite.exec(fs.readFileSync(path.join(migrations, name), "utf8"));
      sqlite.prepare("INSERT INTO schema_migrations(name, applied_at) VALUES(?, ?)").run(name, Date.now());
      sqlite.exec("COMMIT");
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  }
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql, values); }
    first() { return sqlite.prepare(this.sql).get(...this.values) || null; }
    all() { return { success: true, results: sqlite.prepare(this.sql).all(...this.values) }; }
    run() {
      const result = sqlite.prepare(this.sql).run(...this.values);
      return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
  }
  return {
    prepare(sql) { return new Statement(sql); },
    batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(statement => /^\s*SELECT\b/i.test(statement.sql) || /\bRETURNING\b/i.test(statement.sql) ? statement.all() : statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    close() { sqlite.close(); },
  };
}

module.exports = { createDatabase };
