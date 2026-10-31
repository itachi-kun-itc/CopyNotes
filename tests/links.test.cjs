"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
require("../syntax.js");
require("../links.js");
const { find, render } = globalThis.CopyNotesLinks;

test("finds HTTP, HTTPS and www URLs with query strings, fragments and Japanese paths", () => {
  const text = "確認：https://example.com/資料?q=one&lang=ja#見出し。\nhttp://localhost:4173/test www.example.com/path";
  const links = find(text);
  assert.deepEqual(links.map(link => link.text), [
    "https://example.com/資料?q=one&lang=ja#見出し", "http://localhost:4173/test", "www.example.com/path",
  ]);
  assert.equal(links[2].href, "https://www.example.com/path");
  for (const link of links) assert.equal(text.slice(link.start, link.end), link.text);
});

test("excludes sentence punctuation and unmatched brackets while preserving balanced URL paths", () => {
  const text = "(https://example.com/a_(b)). [https://example.com?q=1], 「https://example.jp/」。";
  assert.deepEqual(find(text).map(link => link.text), [
    "https://example.com/a_(b)", "https://example.com?q=1", "https://example.jp/",
  ]);
});

test("never creates executable links and ignores incomplete URLs", () => {
  for (const text of ["javascript:alert(1)", "data:text/html,<script>evil()</script>", "file:///etc/passwd", "https://", "http://?q=a", "ordinary text"]) {
    assert.deepEqual(find(text), [], text);
  }
});

// A small DOM recorder makes text preservation and safe node creation observable.
function node(tag, text = "") {
  return {
    tag, children: [], value: text,
    append(child) { this.children.push(child); },
    set textContent(value) { this.value = value; this.children = []; },
    get textContent() { return this.value + this.children.map(child => child.textContent).join(""); },
  };
}
const document = {
  createDocumentFragment: () => node("fragment"),
  createTextNode: text => node("text", text),
  createElement: tag => node(tag),
};
function descendants(root) { return root.children.flatMap(child => [child, ...descendants(child)]); }

test("preserves every character and existing syntax colors, including URLs spanning tokens", () => {
  const samples = [
    "普通のメモ\n  https://example.com/a?q=1&b=2\t末尾\n",
    'const url = "https://example.com/path?q=yes";\nconsole.log(url);\n',
    'def site():\n\treturn "https://example.com/資料"\n',
    '<a href="https://example.com/path">text</a>',
    "", "plain text without URLs",
  ];
  for (const text of samples) {
    const language = CopyNotesSyntax.detect(text);
    const tokens = CopyNotesSyntax.tokenize(text, language);
    const result = render(document, text, tokens);
    assert.equal(result.textContent, text);
    const anchors = descendants(result).filter(child => child.tag === "a");
    assert.deepEqual(anchors.map(anchor => anchor.textContent), find(text).map(link => link.text));
    for (const anchor of anchors) {
      assert.match(anchor.href, /^https?:\/\//);
      assert.equal(anchor.target, "_blank");
      assert.equal(anchor.rel, "noopener noreferrer");
    }
  }
  const text = "https://example.com/path";
  const tokens = [{ text: "https:", type: "variable" }, { text: "//example.com/path", type: "comment" }];
  const result = render(document, text, tokens);
  assert.equal(result.children.length, 1);
  assert.equal(result.children[0].textContent, text);
  assert.deepEqual(result.children[0].children.map(child => child.className), ["syntax-variable", "syntax-comment"]);
});

test("treats pasted HTML as source text and creates only spans and safe anchors", () => {
  const text = '<img src=x onerror="alert(1)"> https://example.com/<script>alert(1)</script>';
  const result = render(document, text, CopyNotesSyntax.tokenize(text, "html"));
  assert.equal(result.textContent, text);
  assert.ok(descendants(result).every(child => ["a", "span", "text"].includes(child.tag)));
  assert.deepEqual(descendants(result).filter(child => child.tag === "a").map(child => child.href), ["https://example.com/"]);
});
