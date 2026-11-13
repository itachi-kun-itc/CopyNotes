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

test('finds email addresses in Japanese text, punctuation and alongside web links', () => {
  const text = "連絡先：User.Name+notes@example.co.jp。 (support@example.com),\nwww.team@example.org / user@www.example.com https://example.com/?email=inside@example.com www.example.org/contact";
  const links = find(text);
  assert.deepEqual(links.map(link => link.text), [
    'User.Name+notes@example.co.jp', 'support@example.com', 'www.team@example.org', 'user@www.example.com',
    'https://example.com/?email=inside@example.com', 'www.example.org/contact',
  ]);
  assert.equal(links[0].href, 'mailto:User.Name%2Bnotes@example.co.jp');
  assert.equal(links[2].href, 'mailto:www.team@example.org');
  for (const link of links) assert.equal(text.slice(link.start, link.end), link.text);
});

test('incomplete and malformed addresses stay plain text and percent escapes cannot add mail headers', () => {
  for (const text of ['user@', 'user@example', 'user@@example.com', 'user..name@example.com',
    '.user@example.com', 'user@-example.com', 'user@example.com-', 'user@example.c', 'user@example.com_']) {
    assert.deepEqual(find(text), [], text);
  }
  const [link] = find('name%0d%0abcc@example.com');
  assert.equal(link.href, 'mailto:name%250d%250abcc@example.com');
  assert.equal(find('user@example.com?subject=injected')[0].href, 'mailto:user@example.com');
});

test('links telephone numbers without splitting web links or email addresses', () => {
  const text = '電話：090-1234-5678、(050-9876-5432)\n連絡：user@example.com 123-4567-8901@example.com https://example.com/090-1234-5678';
  const links = find(text);
  assert.deepEqual(links.map(link => [link.text, link.href]), [
    ['090-1234-5678', 'tel:+819012345678'], ['050-9876-5432', 'tel:+815098765432'],
    ['user@example.com', 'mailto:user@example.com'], ['123-4567-8901@example.com', 'mailto:123-4567-8901@example.com'],
    ['https://example.com/090-1234-5678', 'https://example.com/090-1234-5678'],
  ]);
  for (const link of links) assert.equal(text.slice(link.start, link.end), link.text);
  for (const text of ['0090-1234-5678', '090-1234-56789', '090-1234-5678-9']) {
    assert.deepEqual(find(text), [], text);
  }
});

test('recognizes varied domestic and international formats while keeping the original text and offsets', () => {
  const samples = [
    ['03-1234-5678', '+81312345678'], ['045-123-4567', '+81451234567'],
    ['0422-12-3456', '+81422123456'], ['09969-2-1234', '+81996921234'],
    ['0120-123-456', '+81120123456'], ['0800-123-4567', '+818001234567'], ['0570-123-456', '+81570123456'],
    ['0312345678', '+81312345678'], ['09012345678', '+819012345678'],
    ['03(1234)5678', '+81312345678'], ['(03) 1234 5678', '+81312345678'],
    ['03 1234 5678', '+81312345678'], ['03.1234.5678', '+81312345678'],
    ['０９０－１２３４－５６７８', '+819012345678'], ['０３（１２３４）５６７８', '+81312345678'],
    ['090ー1234ー5678', '+819012345678'], ['090–1234–5678', '+819012345678'],
    ['+81 (0)90-1234-5678', '+819012345678'], ['+1 (415) 555-2671', '+14155552671'],
    ['+44 20 7946 0958', '+442079460958'], ['+442079460958', '+442079460958'],
    ['03-1234-5678 ext.123', '+81312345678;ext=123'],
  ];
  for (const [number, dial] of samples) {
    const text = `📞連絡先：${number}まで。`;
    const matches = find(text);
    assert.equal(matches.length, 1, number);
    assert.deepEqual(matches[0], { start: text.indexOf(number), end: text.indexOf(number) + number.length, text: number, href: 'tel:' + dial }, number);
    assert.equal(render(document, text, CopyNotesSyntax.tokenize(text, null)).textContent, text);
  }
});

test('separates adjacent phone numbers and leaves dates, postal codes, IPs and ordinary numbers alone', () => {
  const links = find('090-1234-5678 080-9876-5432 / 03-1234-5678');
  assert.deepEqual(links.map(link => link.href), ['tel:+819012345678', 'tel:+818098765432', 'tel:+81312345678']);
  for (const text of ['2026-11-13', '2026/11/13 12:30', '123-4567', '〒123-4567', '192.168.1.100', '1234567', '12345678901234567890']) {
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
    'メール：user@example.com\n',
    'const email = "user.name+tag@example.co.jp";\n',
    '電話：090-1234-5678\n',
    'const phone = "050-9876-5432";\n',
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
      assert.match(anchor.href, /^(?:https?:\/\/|mailto:|tel:)/);
      if (/^(?:mailto:|tel:)/.test(anchor.href)) assert.equal(anchor.target, undefined);
      else {
        assert.equal(anchor.target, "_blank");
        assert.equal(anchor.rel, "noopener noreferrer");
      }
      assert.equal(anchor.className, 'note-link');
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
