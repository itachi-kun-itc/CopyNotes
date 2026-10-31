"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../note-limits.js');
require('../syntax.js');
require('../code-editor.js');
const limits = globalThis.CopyNotesLimits;

class Input extends EventTarget {
  constructor(value = '') {
    super(); this.value = value; this.selectionStart = this.selectionEnd = value.length;
    this.ownerDocument = { execCommand() { throw new Error('Use fallback'); } };
  }
  setSelectionRange(start, end, direction = 'none') {
    this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction;
  }
  setRangeText(text, from, to) {
    this.value = this.value.slice(0, from) + text + this.value.slice(to);
    this.setSelectionRange(from + text.length, from + text.length);
  }
  setAttribute() {}
  fire(type, properties = {}) {
    const event = Object.assign(new Event(type, { cancelable: true }), properties);
    this.dispatchEvent(event); return event;
  }
  type(text, properties = {}) {
    const event = this.fire('beforeinput', { inputType: 'insertText', data: text, ...properties });
    if (!event.defaultPrevented) {
      this.setRangeText(text, this.selectionStart, this.selectionEnd);
      this.fire('input', properties);
    }
    return event;
  }
}
function input(value = '') {
  const result = new Input(value); limits.attach(result); return result;
}

test('the shared limit counts Japanese, newlines and whole Unicode code points', () => {
  assert.equal(limits.maxNoteLength, 3000);
  for (const character of ['a', 'あ', '😀', '\n']) {
    assert.equal(limits.count(character.repeat(3000)), 3000);
    assert.equal(limits.accepts('', character.repeat(3000)), true);
    assert.equal(limits.accepts('', character.repeat(3001)), false);
  }
});

test('typing stops at the boundary and replacing a selection makes room', () => {
  const field = input('あ'.repeat(2999));
  field.type('😀'); assert.equal(limits.count(field.value), 3000);
  assert.equal(field.type('x').defaultPrevented, true);
  assert.equal(limits.count(field.value), 3000);
  field.setSelectionRange(10, 20); field.type('b'.repeat(12));
  assert.equal(field.value, 'あ'.repeat(10) + 'b'.repeat(10) + 'あ'.repeat(2979) + '😀');
});

test('large pastes are clipped at insertion without losing the text after the caret', () => {
  const field = input('a'.repeat(2990) + 'TAIL');
  field.setSelectionRange(2990, 2990);
  const event = field.fire('paste', { clipboardData: { getData: () => '😀'.repeat(100) } });
  assert.equal(event.defaultPrevented, true);
  assert.equal(field.value, 'a'.repeat(2990) + '😀'.repeat(6) + 'TAIL');
  assert.equal(field.selectionStart, 3002);
  assert.equal(field.value.isWellFormed(), true);
  const crlf = limits.replacement('', 0, 0, 'x\r\ny\rz');
  assert.equal(crlf.value, 'x\ny\nz');
});

test('input fallback also limits drop, undo and noncancelable edits while preserving the suffix', () => {
  for (const suffix of ['TAIL', '😀END']) {
    const field = input('a'.repeat(2990) + suffix);
    field.setSelectionRange(2990, 2990);
    field.setRangeText('b'.repeat(100), 2990, 2990); field.fire('input');
    assert.equal(field.value, 'a'.repeat(2990) + 'b'.repeat(10 - limits.count(suffix)) + suffix);
    assert.equal(limits.count(field.value), 3000);
  }
});

test('Japanese composition stays untouched until confirmation and then fits within the limit', () => {
  const field = input('x'.repeat(2999));
  field.fire('compositionstart'); field.type('日本語', { isComposing: true });
  assert.equal(field.value, 'x'.repeat(2999) + '日本語');
  field.fire('compositionend');
  assert.equal(field.value, 'x'.repeat(2999) + '日');
  assert.equal(field.selectionStart, 3000);
});

test('existing long notes are preserved on load, can shrink, and cannot grow', () => {
  const field = input('あ'.repeat(3100));
  assert.equal(limits.count(field.value), 3100);
  field.type('new'); assert.equal(limits.count(field.value), 3100);
  field.setSelectionRange(0, 100); field.type('短');
  assert.equal(field.value, '短' + 'あ'.repeat(3000));
  field.setRangeText('', 0, 1); field.fire('input');
  assert.equal(limits.count(field.value), 3000);
  field.type('x'); assert.equal(limits.count(field.value), 3000);
});

test('programmatic remote refresh is used as the baseline for the next user edit', () => {
  const field = input('old');
  field.value = 'a'.repeat(2990) + 'TAIL'; field.setSelectionRange(2990, 2990);
  field.type('b'.repeat(100));
  assert.equal(field.value, 'a'.repeat(2990) + 'b'.repeat(6) + 'TAIL');
});

test('code completion, indentation and formatted paste cannot bypass the limit', () => {
  const field = input('x = ' + '1'.repeat(2995));
  CopyNotesEditor.attach(field);
  field.type('(');
  assert.equal(limits.count(field.value), 3000);
  assert.equal(field.value.endsWith('('), true, 'raw input fits when a closing pair does not');
  assert.equal(field.fire('keydown', { key: 'Enter' }).defaultPrevented, false);
  assert.equal(limits.count(field.value), 3000);
  field.fire('keydown', { key: 'Tab' }); assert.equal(limits.count(field.value), 3000);
  field.setSelectionRange(2990, 3000);
  field.fire('paste', { clipboardData: { getData: () => 'if ready:\n    run()'.repeat(50) } });
  assert.equal(limits.count(field.value), 3000);
  const python = input('#' + 'x'.repeat(2988) + '\nif ready:');
  CopyNotesEditor.attach(python);
  assert.equal(python.fire('keydown', { key: 'Enter' }).defaultPrevented, false);
  python.type('\n', { inputType: 'insertLineBreak' });
  assert.equal(limits.count(python.value), 3000);
  assert.equal(python.value.endsWith('if ready:\n'), true);
});
