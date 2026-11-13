"use strict";

globalThis.CopyNotesLinks = (() => {
  const phoneNumbers = typeof require === 'function' ? require('./assets/vendor/libphonenumber-max.js') : globalThis.libphonenumber;
  function find(text) {
    const links = [];
    const pattern = /(?<email>[a-z0-9_%+'-]+(?:\.[a-z0-9_%+'-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:xn--[a-z0-9-]{2,59}|[a-z]{2,63}))|\b(?:https?:\/\/|www\.)[^\s<>"'`「」『』【】（）｛｝［］、。！？]+/gi;
    for (const match of text.matchAll(pattern)) {
      if (match.groups.email) {
        // Avoid turning a suffix of an incomplete or malformed address into a link.
        const before = text[match.index - 1] || '';
        const after = text[match.index + match[0].length] || '';
        if (/[a-z0-9.!#$%&'*+/=?^_`{|}~@-]/i.test(before) || /[a-z0-9_@-]/i.test(after)) continue;
        const label = match[0];
        const at = label.lastIndexOf('@');
        // Encode the mailbox so pasted percent escapes cannot become mail headers.
        const href = `mailto:${encodeURIComponent(label.slice(0, at))}@${label.slice(at + 1)}`;
        links.push({ start: match.index, end: match.index + label.length, text: label, href });
        continue;
      }
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
    // Mask web/email links before searching for numbers, retaining UTF-16 offsets.
    let phoneText = '', position = 0;
    for (const link of links) {
      phoneText += text.slice(position, link.start) + ' '.repeat(link.end - link.start);
      position = link.end;
    }
    phoneText += text.slice(position);
    phoneText = phoneText.replace(/[‐‑‒–—―−ー－]/g, '-');
    // Separate contact lists before matching so a slash cannot swallow earlier numbers.
    for (const chunk of phoneText.matchAll(/[^\r\n/,;、，；]+/g)) {
      for (const match of phoneNumbers.findPhoneNumbersInText(chunk[0], 'JP')) {
        let start = chunk.index + match.startsAt;
        const end = chunk.index + match.endsAt;
        while (/[（(]/.test(text[start]) && (text.slice(start, end).match(/[（(]/g) || []).length > (text.slice(start, end).match(/[）)]/g) || []).length) start++;
        if (/[0-9０-９-]/.test(phoneText[start - 1] || '') || /[0-9０-９-]/.test(phoneText[end] || '')) continue;
        links.push({ start, end, text: text.slice(start, end), href: match.number.getURI() });
      }
    }
    return links.sort((a, b) => a.start - b.start);
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
      if (/^https?:/.test(link.href)) {
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
      }
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
