"use strict";

globalThis.CopyNotesLimits = (() => {
  const maxNoteLength = 3000;
  const count = text => Array.from(text).length;
  const accepts = (previous, next) => count(next) <= maxNoteLength || count(next) < count(previous);

  function replacement(value, from, to, inserted) {
    inserted = inserted.replace(/\r\n?/g, '\n');
    const prefix = value.slice(0, from), suffix = value.slice(to);
    const available = maxNoteLength - count(prefix) - count(suffix);
    // Preserve legacy long notes rather than silently deleting their contents.
    if (available < 0) return { value, from, caret: from, insertEnd: from + inserted.length, inserted: '' };
    const text = Array.from(inserted).slice(0, available).join('');
    return { value: prefix + text + suffix, from, caret: from + text.length,
      insertEnd: from + inserted.length, inserted: text };
  }

  function fitChange(previous, next) {
    const before = Array.from(previous), after = Array.from(next);
    let start = 0, end = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    while (end < before.length - start && end < after.length - start
      && before[before.length - end - 1] === after[after.length - end - 1]) end++;
    const from = before.slice(0, start).join('').length;
    const to = previous.length - before.slice(before.length - end).join('').length;
    return replacement(previous, from, to, after.slice(start, after.length - end).join(''));
  }

  function attach(input) {
    let previous = input.value;
    let composing = false;
    let inserting = false;

    function enforce() {
      const next = input.value;
      if (!accepts(previous, next)) {
        const fitted = fitChange(previous, next);
        const map = position => Math.max(0, Math.min(fitted.value.length,
          position <= fitted.from ? position : position >= fitted.insertEnd
            ? position + fitted.value.length - next.length : Math.min(position, fitted.caret)));
        const start = map(input.selectionStart), end = map(input.selectionEnd);
        const direction = input.selectionDirection;
        input.value = fitted.value;
        input.setSelectionRange(start, end, direction);
      }
      previous = input.value;
    }

    function insert(event, text) {
      const { value, selectionStart: start, selectionEnd: end } = input;
      text = text.replace(/\r\n?/g, '\n');
      if (accepts(value, value.slice(0, start) + text + value.slice(end))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const fitted = replacement(value, start, end, text);
      if (fitted.value === value) return;
      inserting = true;
      try {
        // Keep native undo history when the browser supports editing commands.
        try { input.ownerDocument.execCommand('insertText', false, fitted.inserted); } catch { /* Use setRangeText below. */ }
        if (input.value !== fitted.value) {
          input.setRangeText(fitted.value, 0, input.value.length, 'end');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        input.setSelectionRange(fitted.caret, fitted.caret);
        previous = input.value;
      } finally { inserting = false; }
    }

    input.addEventListener('beforeinput', event => {
      if (inserting) { event.stopImmediatePropagation(); return; }
      if (composing || event.isComposing) return;
      previous = input.value;
      if (!event.cancelable) return;
      if (['insertLineBreak', 'insertParagraph'].includes(event.inputType)) insert(event, '\n');
      else if (event.inputType.startsWith('insert') && typeof event.data === 'string') insert(event, event.data);
    }, true);
    input.addEventListener('paste', event => {
      if (!composing && event.clipboardData) {
        previous = input.value;
        insert(event, event.clipboardData.getData('text/plain'));
      }
    }, true);
    input.addEventListener('keydown', () => { if (!composing) previous = input.value; }, true);
    input.addEventListener('compositionstart', () => { previous = input.value; composing = true; });
    input.addEventListener('compositionend', () => {
      composing = false;
      enforce();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    input.addEventListener('input', () => { if (!composing) enforce(); }, true);
  }

  return Object.freeze({ maxNoteLength, count, accepts, replacement, fitChange, attach });
})();
