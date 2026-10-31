"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
require("../syntax.js");
const { detect, tokenize } = globalThis.CopyNotesSyntax;

const samples = [
  ["python", 'def greet(name):\n    # あいさつ\n    print("こんにちは", name, 42)\n'],
  ["python", 'from pathlib import Path\npath = Path("file.txt")'],
  ["python", 'import os\nprint("<div>text</div>")'],
  ["python", 'data = {"name": "太郎", "count": 1}'],
  ["javascript", 'const theme = { color: "red" };\nconsole.log(theme);'],
  ["javascript", 'import React from "react";'],
  ["javascript", 'class Example { run() { return 1; } }'],
  ["typescript", 'const count: number = 42;'],
  ["html", '<div title="example"><script>alert("test")</script></div>'],
  ["css", '.button { color: #fff; margin: 12px; }'],
  ["css", 'body { background: red; }'],
  ["json", '{"name": "太郎", "html": "<div>", "enabled": true, "count": 2}'],
  ["sql", "SELECT name FROM users WHERE id = 42; -- comment"],
  ["python", '```python\nprint("test")\n```'],
];

test("detects snippets without confusing embedded text with another language", () => {
  for (const [language, text] of samples) assert.equal(detect(text), language, text);
  for (const text of ["", "こんにちは", "明日の予定をメモする", "https://example.com", "これは普通のメモです。\n2行目もそのまま。"])
    assert.equal(detect(text), null, text);
});

test("preserves source text, indentation, tabs, and trailing newlines", () => {
  for (const [language, text] of [...samples, ["python", 'def f():\n\treturn """multi\nline"""\n\n']])
    assert.equal(tokenize(text, language).map(token => token.text).join(""), text);
});

test("colors Python keywords, functions, strings, numbers, and comments separately", () => {
  const tokens = tokenize(samples[0][1], "python");
  for (const [text, type] of [["def", "keyword"], ["greet", "function"], ["print", "function"], ['"こんにちは"', "string"], ["42", "number"], ["# あいさつ", "comment"]])
    assert.ok(tokens.some(token => token.text === text && token.type === type), `${text}: ${type}`);
});

test("handles incomplete strings and comments while typing", () => {
  for (const [language, text] of [["python", 'print("unfinished'], ["python", 'x = """unfinished\ntext'], ["javascript", 'const x = /* unfinished'], ["html", '<!-- unfinished']])
    assert.equal(tokenize(text, language).map(token => token.text).join(""), text);
});
