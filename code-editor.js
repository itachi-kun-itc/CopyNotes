"use strict";

globalThis.CopyNotesEditor = (() => {
  const pairs = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
  const voidTags = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
  const syntax = () => globalThis.CopyNotesSyntax;
  const leading = line => /^[\t ]*/.exec(line)[0];
  const lineStart = (text, position) => position > 0 ? text.lastIndexOf("\n", position - 1) + 1 : 0;

  function indentUnit(text, language) {
    const indents = text.split("\n").filter(line => line.trim()).map(leading).filter(Boolean);
    if (indents.some(indent => indent.includes("\t"))) return "\t";
    const sizes = indents.map(indent => indent.length);
    const gcd = (a, b) => b ? gcd(b, a % b) : a;
    const size = sizes.length ? sizes.reduce(gcd) : 0;
    return " ".repeat(size >= 2 && size <= 4 ? size : language === "python" ? 4 : 2);
  }

  function stringIsOpen(value) {
    const source = value.replace(/^[rRuUbBfF]{1,2}(?=["'])/, "");
    const delimiter = /^(?:"""|''')/.exec(source)?.[0] || source[0];
    if (source.length < delimiter.length * 2 || !source.endsWith(delimiter)) return true;
    const beforeEnd = source.slice(0, -delimiter.length);
    return (/\\*$/.exec(beforeEnd)[0].length % 2) === 1;
  }

  function context(text, position, language) {
    const before = text.slice(0, position);
    const tokens = syntax().tokenize(before, language);
    const last = tokens.at(-1);
    const inString = last?.type === "string" && /^(?:[rRuUbBfF]{0,2})["'`]/.test(last.text) && stringIsOpen(last.text);
    const inComment = last?.type === "comment" && !last.text.endsWith("\n")
      && !/^(?:\/\*[\s\S]*\*\/|<!--[\s\S]*-->)$/.test(last.text);
    const code = tokens.map(token => token.type === "string" || token.type === "comment"
      ? token.text.replace(/[^\r\n]/g, " ") : token.text).join("");
    const stack = [];
    for (let i = 0; i < code.length; i++) {
      const char = code[i];
      if ("([{".includes(char)) {
        stack.push({ char, index: i, indent: leading(before.slice(lineStart(before, i))), column: i - lineStart(before, i) });
      } else if ([")", "]", "}"].includes(char) && pairs[stack.at(-1)?.char] === char) stack.pop();
    }
    const quote = inString ? last.text.replace(/^[rRuUbBfF]{1,2}(?=["'])/, "")[0] : null;
    return { code, stack, inString, inComment, quote };
  }

  function tagStack(code, source) {
    const stack = [];
    for (const match of code.matchAll(/<\/?([a-z][\w:-]*)\b[^>]*>/gi)) {
      const tag = match[1].toLowerCase();
      if (match[0].startsWith("</")) {
        const index = stack.findLastIndex(item => item.tag === tag);
        if (index >= 0) stack.splice(index);
      } else if (!voidTags.has(tag) && !/\/\s*>$/.test(match[0])) {
        stack.push({ tag, indent: leading(source.slice(lineStart(source, match.index))) });
      }
    }
    return stack;
  }

  function edit(from, to, text, anchor = from + text.length, head = anchor) {
    return { from, to, text, anchor, head };
  }

  function outdent(indent, unit) {
    if (indent.endsWith("\t")) return indent.slice(0, -1);
    return indent.slice(0, Math.max(0, indent.length - unit.length));
  }

  function branchIndent(text, start, line, language) {
    const current = leading(line);
    if (language !== "python") return current;
    const keyword = /^\s*(elif|else|except|finally|case)\b/.exec(line)?.[1];
    if (!keyword) return current;
    const candidates = keyword === "elif" ? /^(if|elif)\b/ : keyword === "except" ? /^(try|except)\b/
      : keyword === "case" ? /^(match|case)\b/ : /^(if|elif|for|while|try|except|else)\b/;
    for (const previous of text.slice(0, start).split("\n").reverse()) {
      const indent = leading(previous);
      if (indent.length < current.length && candidates.test(previous.trim())) {
        return keyword === "case" && previous.trim().startsWith("match") ? indent + indentUnit(text, language) : indent;
      }
    }
    return current;
  }

  function newline(text, start, end = start, language = syntax().detect(text)) {
    if (!language) return null;
    const unit = indentUnit(text, language);
    const begin = lineStart(text, start);
    const line = text.slice(begin, start);
    const info = context(text, start, language);
    const codeLine = info.code.slice(begin).trimEnd();
    let base = branchIndent(text, begin, line, language);
    const lineOpener = context(text, begin, language).stack.at(-1);
    if (lineOpener && line.trimStart().startsWith(pairs[lineOpener.char])) base = lineOpener.indent;
    if (language === "html" && /^\s*<\//.test(line)) {
      const tag = tagStack(context(text, begin, language).code, text).at(-1);
      if (tag) base = tag.indent;
    }
    let indent = base;
    let closingIndent = null;
    let expand = false;
    let to = end;

    if (!info.inString) {
      const opener = info.stack.at(-1);
      const after = text.slice(end);
      if (language === "html") {
        const tag = tagStack(info.code, text).at(-1);
        const lastTag = /<([a-z][\w:-]*)\b[^>]*>\s*$/i.exec(codeLine);
        if (tag && lastTag && !voidTags.has(lastTag[1].toLowerCase()) && !/\/\s*>\s*$/.test(lastTag[0])) {
          indent = base + unit;
          closingIndent = tag.indent;
          expand = new RegExp(`^[\\t ]*</${tag.tag}\\s*>`, "i").test(after);
        }
      } else if (opener) {
        const tail = info.code.slice(opener.index + 1);
        if (!tail.includes("\n")) {
          indent = language === "python" && tail.trim() && opener.char === "("
            ? " ".repeat(opener.column + 1) : opener.indent + unit;
        } else if (base.length <= opener.indent.length) indent = opener.indent + unit;
        closingIndent = opener.indent;
        if (after.replace(/^[\t ]*/, "").startsWith(pairs[opener.char])) {
          expand = !tail.trim();
          if (!expand) indent = closingIndent;
        }
      } else if (language === "python") {
        if (codeLine.endsWith(":")) indent = base + unit;
        else if (/^\s*(?:return|raise|break|continue|pass)\b/.test(codeLine)) indent = outdent(base, unit);
        else if (/\\$/.test(codeLine)) indent = base + unit;
      } else if (language === "sql") {
        if (/^\s*(?:BEGIN|CASE|SELECT)\s*$/i.test(codeLine)) indent = base + unit;
        else if (/^\s*END\b/i.test(codeLine)) indent = outdent(base, unit);
      }
      to += /^[\t ]*/.exec(after)[0].length;
    }

    // Align Python continuation clauses with their enclosing block.
    const from = base !== leading(line) ? begin : start;
    const prefix = from === begin ? base + line.trimStart() : "";
    const inserted = prefix + "\n" + indent + (expand ? "\n" + closingIndent : "");
    return edit(from, to, inserted, from + prefix.length + 1 + indent.length);
  }

  function indent(text, start, end = start, backwards = false, language = syntax().detect(text)) {
    if (!language) return null;
    const unit = indentUnit(text, language);
    if (!backwards && start === end) return edit(start, end, unit);
    const begin = lineStart(text, start);
    const last = lineStart(text, end > start && text[end - 1] === "\n" ? end - 1 : end);
    const lineEnd = text.indexOf("\n", last);
    const finish = lineEnd < 0 ? text.length : lineEnd;
    const changes = [];
    let position = begin;
    const lines = text.slice(begin, finish).split("\n").map(line => {
      const remove = backwards ? Math.min(leading(line).length, line.startsWith("\t") ? 1 : unit.length) : 0;
      const add = backwards ? "" : unit;
      changes.push({ position, remove, add: add.length });
      position += line.length + 1;
      return add + line.slice(remove);
    });
    const map = point => {
      let delta = 0;
      for (const change of changes) {
        if (point < change.position) break;
        if (point <= change.position + change.remove) return change.position + delta + change.add;
        delta += change.add - change.remove;
      }
      return point + delta;
    };
    return edit(begin, finish, lines.join("\n"), map(start), map(end));
  }

  function backspace(text, start, end = start, language = syntax().detect(text)) {
    if (!language || start !== end || start === 0) return null;
    if (language === "python" && ['"', "'"].some(quote => text.slice(start - 3, start) === quote.repeat(3) && text.slice(start, start + 3) === quote.repeat(3))) return edit(start - 3, start + 3, "");
    if (pairs[text[start - 1]] && pairs[text[start - 1]] === text[start]) return edit(start - 1, start + 1, "");
    const before = text.slice(lineStart(text, start), start);
    if (!/^[\t ]+$/.test(before)) return null;
    const unit = indentUnit(text, language);
    const count = before.endsWith("\t") ? 1 : (before.length % unit.length || unit.length);
    return edit(start - count, start, "");
  }

  function character(text, start, end, char, language = syntax().detect(text)) {
    language ||= syntax().detect(text.slice(0, start) + char + text.slice(end));
    if (!language) return null;
    const info = context(text, start, language);
    const isQuote = /["'`]/.test(char);
    if (isQuote && (/\\*$/.exec(text.slice(0, start))[0].length % 2)) return null;
    if (language === "python" && ['"', "'"].includes(char) && start === end && text.slice(start - 2, start) === char.repeat(2) && text[start - 3] !== char && !info.inComment) {
      return edit(start, end, char.repeat(4), start + 1);
    }
    if (start === end && text[start] === char && Object.values(pairs).includes(char)) {
      if (!info.inComment && (isQuote ? info.inString && info.quote === char : !info.inString)) return edit(start, start, "", start + 1);
    }
    if (info.inString || info.inComment) return null;
    if (char === ">" && language === "html") {
      const tag = /<([a-z][\w:-]*)\b[^<>]*$/i.exec(text.slice(0, start));
      if (tag && !/\/\s*$/.test(tag[0]) && !voidTags.has(tag[1].toLowerCase()) && !text.slice(end).toLowerCase().startsWith(`</${tag[1].toLowerCase()}`)) {
        return edit(start, end, `></${tag[1]}>`, start + 1);
      }
    }
    if ([")", "]", "}"].includes(char) && start === end && /^[\t ]*$/.test(text.slice(lineStart(text, start), start))) {
      const opener = info.stack.at(-1);
      if (opener && pairs[opener.char] === char) return edit(lineStart(text, start), end, opener.indent + char);
    }
    if (!pairs[char] || char === "`" && !["javascript", "typescript"].includes(language)) return null;
    if (isQuote && /[\p{L}\p{N}_$]/u.test(text[start - 1] || "")) return null;
    const selected = text.slice(start, end);
    if (selected) return edit(start, end, char + selected + pairs[char], start + 1, end + 1);
    if (text[start] && !/[\s)\]},;:]/.test(text[start])) return null;
    return edit(start, end, char + pairs[char], start + 1);
  }

  function paste(text, start, end, inserted, language = syntax().detect(inserted) || syntax().detect(text)) {
    if (!language || !/[\r\n]/.test(inserted)) return null;
    const existingLanguage = syntax().detect(text);
    if (existingLanguage && context(text, start, existingLanguage).inString) return null;
    inserted = inserted.replace(/\r\n?/g, "\n");
    const lines = inserted.split("\n");
    const unit = indentUnit(inserted, language);
    const base = leading(text.slice(lineStart(text, start), start));
    const protectedLines = new Set();
    let lineNumber = 0;
    const tokens = syntax().tokenize(inserted, language);
    const masked = tokens.map(token => {
      const count = (token.text.match(/\n/g) || []).length;
      if (token.type === "string" || token.type === "comment") {
        for (let i = 1; i <= count; i++) protectedLines.add(lineNumber + i);
      }
      lineNumber += count;
      return token.type === "string" || token.type === "comment" ? token.text.replace(/[^\n]/g, " ") : token.text;
    }).join("").split("\n");
    const common = Math.min(...lines.filter(line => line.trim()).map(line => leading(line).length), Infinity);
    const stack = [];
    let htmlSource = "";
    let htmlCode = "";
    const structural = ["javascript", "typescript", "json", "css"].includes(language);
    const formatted = lines.map((line, index) => {
      const code = masked[index];
      let depth = stack.length;
      if (structural) depth = Math.max(0, depth - (/^[\t ]*([)\]}]+)/.exec(code)?.[1].length || 0));
      else if (language === "html") {
        depth = tagStack(htmlCode, htmlSource).length;
        const closingTags = /^\s*((?:<\/[\w:-]+\s*>\s*)+)/.exec(code)?.[1];
        if (closingTags) depth = Math.max(0, depth - (closingTags.match(/<\//g) || []).length);
      }
      let result;
      if (protectedLines.has(index)) result = line;
      else if (!line.trim()) result = "";
      else if (structural || language === "html") result = (index ? base : "") + unit.repeat(depth) + line.trimStart();
      else result = (index ? base : "") + line.slice(Number.isFinite(common) ? common : 0);
      if (structural) {
        for (const char of code) {
          if ("([{".includes(char)) stack.push(char);
          else if (pairs[stack.at(-1)] === char) stack.pop();
        }
      }
      htmlSource += line + "\n";
      htmlCode += code + "\n";
      return result;
    }).join("\n");
    return formatted !== inserted ? edit(start, end, formatted) : null;
  }

  function attach(input) {
    let composing = false;
    let escapeTab = false;
    function apply(change) {
      if (!change) return false;
      if (change.from === change.to && !change.text) {
        input.setSelectionRange(change.anchor, change.head);
        return true;
      }
      const expected = input.value.slice(0, change.from) + change.text + input.value.slice(change.to);
      input.setSelectionRange(change.from, change.to);
      // Native insertion preserves the browser's undo/redo history.
      try { document.execCommand("insertText", false, change.text); } catch { /* Use the textarea fallback. */ }
      if (input.value !== expected) {
        input.setRangeText(expected, 0, input.value.length, "end");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      input.setSelectionRange(change.anchor, change.head);
      return true;
    }
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", () => { composing = false; });
    input.addEventListener("keydown", event => {
      if (event.isComposing || composing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") { escapeTab = true; return; }
      if (event.key === "Tab" && escapeTab) { escapeTab = false; return; }
      escapeTab = false;
      const { value, selectionStart: start, selectionEnd: end } = input;
      const language = syntax().detect(value);
      const change = event.key === "Enter" ? newline(value, start, end, language)
        : event.key === "Tab" ? indent(value, start, end, event.shiftKey, language)
        : event.key === "Backspace" ? backspace(value, start, end, language) : null;
      if (change) { event.preventDefault(); apply(change); }
    });
    input.addEventListener("beforeinput", event => {
      if (event.isComposing || composing || !event.cancelable) return;
      const { value, selectionStart: start, selectionEnd: end } = input;
      const language = syntax().detect(value);
      const change = ["insertLineBreak", "insertParagraph"].includes(event.inputType) ? newline(value, start, end, language)
        : event.inputType === "insertText" && event.data?.length === 1 ? character(value, start, end, event.data, language)
        : event.inputType === "deleteContentBackward" ? backspace(value, start, end, language) : null;
      if (change) { event.preventDefault(); apply(change); }
    });
    input.addEventListener("paste", event => {
      if (composing || !event.clipboardData) return;
      const inserted = event.clipboardData.getData("text/plain");
      const change = paste(input.value, input.selectionStart, input.selectionEnd, inserted);
      if (change) { event.preventDefault(); apply(change); }
    });
    input.autocapitalize = "off";
    input.setAttribute("autocorrect", "off");
  }

  return Object.freeze({ indentUnit, newline, indent, backspace, character, paste, attach });
})();
