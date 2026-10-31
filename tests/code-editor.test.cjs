"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
require("../syntax.js");
require("../code-editor.js");
const editor = globalThis.CopyNotesEditor;
const syntax = globalThis.CopyNotesSyntax;
const apply = (source, change) => change ? source.slice(0, change.from) + change.text + source.slice(change.to) : source;
const enter = (source, language, position = source.length) => apply(source, editor.newline(source, position, position, language));

test("Python suites automatically indent, including nested and asynchronous blocks", () => {
  for (const line of ["for i in range(3):", "while ready:", "if ready:", "elif ready:", "else:", "try:", "except ValueError:", "finally:", "def greet(name):", "class Example:", "with open(path) as file:", "async def main():", "async for item in source:", "async with context:", "match value:", "case 1:"])
    assert.equal(enter(line, "python"), line + "\n    ", line);
  assert.equal(enter("for i in range(3):\n    if i:", "python"), "for i in range(3):\n    if i:\n        ");
  assert.equal(enter("if ready: # explanation", "python"), "if ready: # explanation\n    ");
});

test("Python terminal statements dedent and continuation clauses align", () => {
  for (const terminal of ["return value", "raise Error()", "pass", "continue", "break"])
    assert.equal(enter("def main():\n    " + terminal, "python"), "def main():\n    " + terminal + "\n");
  assert.equal(enter("if ready:\n    work()\n    else:", "python"), "if ready:\n    work()\nelse:\n    ");
  assert.equal(enter("try:\n    work()\n    except Error:", "python"), "try:\n    work()\nexcept Error:\n    ");
});

test("reuses existing spaces or tabs and aligns multiline Python arguments", () => {
  assert.equal(editor.indentUnit("if x:\n  run()", "python"), "  ");
  assert.equal(enter("if x:\n\tif y:", "python"), "if x:\n\tif y:\n\t\t");
  assert.equal(enter("result = process(first,", "python"), "result = process(first,\n" + " ".repeat(17));
  assert.equal(enter("def run(\n    value,\n):", "python"), "def run(\n    value,\n):\n    ");
});

test("bracket pairs create an indented blank line with the caret inside", () => {
  for (const [source, language, expected] of [
    ["function run() {}", "javascript", "function run() {\n  \n}"],
    ['{"items": []}', "json", '{"items": [\n  \n]}'],
    ["values = []", "python", "values = [\n    \n]"],
    [".button {}", "css", ".button {\n  \n}"],
  ]) {
    const position = source.indexOf(language === "json" || language === "python" ? "[" : "{") + 1;
    const change = editor.newline(source, position, position, language);
    assert.equal(apply(source, change), expected);
    assert.equal(apply(source, change)[change.anchor], "\n");
  }
  assert.equal(enter("function run() {\n}", "javascript", 16), "function run() {\n  \n}");
});

test("strings and comments do not create false code blocks", () => {
  assert.equal(enter('x = "not a block: {"', "python"), 'x = "not a block: {"\n');
  assert.equal(enter("# if x:", "python"), "# if x:\n");
  assert.equal(editor.character('print("text', 11, 11, "(", "python"), null);
  assert.equal(editor.character("const x = 1; // comment", 23, 23, "{", "javascript"), null);
});

test("HTML closes nonvoid tags, indents between tags, and ignores void tags", () => {
  const source = '<div class="card"';
  assert.equal(apply(source, editor.character(source, source.length, source.length, ">", "html")), '<div class="card"></div>');
  assert.equal(editor.character("<input", 6, 6, ">", "html"), null);
  assert.equal(enter("<div></div>", "html", 5), "<div>\n  \n</div>");
  assert.equal(enter("<div>\n  <br>", "html"), "<div>\n  <br>\n  ");
});

test("brackets and quotes complete, skip existing closers, and wrap selections", () => {
  const source = "def run";
  const change = editor.character(source, source.length, source.length, "(");
  assert.equal(apply(source, change), "def run()");
  assert.equal(change.anchor, source.length + 1);
  assert.equal(editor.character("values = []", 10, 10, "]", "python").anchor, 11);
  assert.equal(apply("x = item", editor.character("x = item", 4, 8, "(", "python")), "x = (item)");
  assert.equal(apply("x = ", editor.character("x = ", 4, 4, '"', "python")), 'x = ""');
});

test("closing delimiters align and Backspace removes a pair or one indentation step", () => {
  const source = "function run() {\n  ";
  assert.equal(apply(source, editor.character(source, source.length, source.length, "}", "javascript")), "function run() {\n}");
  assert.equal(apply("x = ()", editor.backspace("x = ()", 5, 5, "python")), "x = ");
  assert.equal(apply("if x:\n    ", editor.backspace("if x:\n    ", 10, 10, "python")), "if x:\n");
});

test("Tab and Shift+Tab indent selected lines and preserve selection boundaries", () => {
  const source = "if x:\n    one()\n    two()\nnext()";
  const start = source.indexOf("    one");
  const end = source.indexOf("next");
  const change = editor.indent(source, start, end, false, "python");
  const indented = apply(source, change);
  assert.equal(indented, "if x:\n        one()\n        two()\nnext()");
  assert.equal(apply(indented, editor.indent(indented, change.anchor, change.head, true, "python")), source);
  assert.equal(apply("x = 1", editor.indent("x = 1", 5, 5, false, "python")), "x = 1    ");
});

test("multiline paste formats structural languages and preserves Python block meaning", () => {
  const js = 'function run() {\nconsole.log("hello");\n}';
  assert.equal(apply("", editor.paste("", 0, 0, js)), 'function run() {\n  console.log("hello");\n}');
  const html = '<div>\n<span>text</span>\n</div>';
  assert.equal(apply("", editor.paste("", 0, 0, html)), '<div>\n  <span>text</span>\n</div>');
  const prefix = "if ready:\n    ";
  const py = "for item in items:\n    print(item)\nprint('done')";
  assert.equal(apply(prefix, editor.paste(prefix, prefix.length, prefix.length, py)), prefix + "for item in items:\n        print(item)\n    print('done')");
  const template = 'const message = `line one\n  keep these spaces\nline three`;';
  assert.equal(editor.paste("", 0, 0, template), null);
});

test("plain text stays unchanged and incomplete code is recognized early", () => {
  const source = "これは普通のメモ";
  assert.equal(editor.newline(source, source.length), null);
  assert.equal(editor.indent(source, 0), null);
  assert.equal(editor.character(source, source.length, source.length, "("), null);
  assert.equal(editor.paste("", 0, 0, "普通のメモ\n2行目"), null);
  assert.equal(syntax.detect("{"), "json");
  assert.equal(syntax.detect(".button {"), "css");
  assert.equal(syntax.detect("if (ready) {"), "javascript");
});

test("literal brackets, escaped quotes, and triple-quoted strings remain editable", () => {
  const literal = 'x = "a]b"';
  assert.equal(editor.character(literal, literal.indexOf("]"), literal.indexOf("]"), "]", "python"), null);
  const source = 'x = ""';
  assert.equal(apply(source, editor.character(source, source.length, source.length, '"', "python")), 'x = """"""');
  assert.equal(apply('x = """"""', editor.backspace('x = """"""', 7, 7, "python")), "x = ");
  const prefix = 'x = "text\\';
  assert.equal(editor.character(prefix, prefix.length, prefix.length, '"', "python"), null);
  assert.equal(editor.paste('x = """', 7, 7, 'function run() {\nkeep_literal();\n}'), null);
});

test("all detected languages retain indentation support", () => {
  for (const [source, language, expected] of [
    ["const run: Function = () => {", "typescript", "const run: Function = () => {\n  "],
    ['{"items": [', "json", '{"items": [\n  '],
    [".button {", "css", ".button {\n  "],
    ["SELECT", "sql", "SELECT\n  "],
    ["SELECT\n  name,", "sql", "SELECT\n  name,\n  "],
  ]) assert.equal(enter(source, language), expected, language);
  const json = '{\n"items": [\n1,\n2\n]\n}';
  assert.equal(apply("", editor.paste("", 0, 0, json)), '{\n  "items": [\n    1,\n    2\n  ]\n}');
  const css = '.button {\ncolor: red;\n}';
  assert.equal(apply("", editor.paste("", 0, 0, css)), '.button {\n  color: red;\n}');
});
