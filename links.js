"use strict";

globalThis.CopyNotesLinks = (() => {
  function find(text) {
    const links = [];
    const pattern = /\b(?:https?:\/\/|www\.)[^\s<>"'`「」『』【】（）｛｝［］、。！？]+/gi;
    for (const match of text.matchAll(pattern)) {
      let label = match[0].replace(/[.,!?;:]+$/, "");
      // Keep balanced parentheses in paths, but leave surrounding punctuation out.
      while (/[)\]}]$/.test(label)) {
        const close = label.at(-1);
        const open = { ")": "(", "]": "[", "}": "{" }[close];
        if (label.split(close).length <= label.split(open).length) break;
        label = label.slice(0, -1).replace(/[.,!?;:]+$/, "");
      }
      try {
        const url = new URL(/^www\./i.test(label) ? `https://${label}` : label);
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname) continue;
        links.push({ start: match.index, end: match.index + label.length, text: label, href: url.href });
      } catch {
        // Incomplete URLs remain ordinary editable text.
      }
    }
    return links;
  }

  function render(document, text, tokens, links = find(text)) {
    const fragment = document.createDocumentFragment();
    let tokenIndex = 0;
    let tokenOffset = 0;
    // Consume original syntax tokens in order, including URLs spanning tokens.
    function append(parent, length) {
      while (length > 0) {
        const token = tokens[tokenIndex];
        const value = token.text.slice(tokenOffset, tokenOffset + length);
        if (token.type) {
          const span = document.createElement("span");
          span.className = `syntax-${token.type}`;
          span.textContent = value;
          parent.append(span);
        } else parent.append(document.createTextNode(value));
        length -= value.length;
        tokenOffset += value.length;
        if (tokenOffset === token.text.length) { tokenIndex++; tokenOffset = 0; }
      }
    }
    let position = 0;
    for (const link of links) {
      append(fragment, link.start - position);
      const anchor = document.createElement("a");
      anchor.href = link.href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.className = "note-link";
      append(anchor, link.end - link.start);
      fragment.append(anchor);
      position = link.end;
    }
    append(fragment, text.length - position);
    return fragment;
  }

  return { find, render };
})();
