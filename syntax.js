"use strict";

// Lightweight highlighting; all source text is displayed as text, never as HTML.
globalThis.CopyNotesSyntax = (() => {
  const words = value => new Set(value.split(" "));
  const keywords = {
    python: words("def class lambda True False None self cls"),
    javascript: words("const let var function class extends new this super true false null undefined static get set typeof instanceof void delete"),
    typescript: words("const let var function class extends new this super true false null undefined static get set typeof instanceof void delete interface type enum implements public private protected readonly abstract string number boolean any unknown never"),
    sql: words("select from where join left right inner outer on as insert into values update set delete create table alter drop distinct group by order asc desc having limit offset union all null true false primary key not and or in is like"),
  };
  const control = {
    python: words("if elif else for while in is not and or try except finally with as import from return yield raise break continue pass assert del global nonlocal async await match case"),
    javascript: words("if else for while do switch case default try catch finally return throw break continue import from export async await yield of in"),
  };
  const builtins = words("print len range str int float bool list dict set tuple object bytes type enumerate zip map filter sum min max abs round open input isinstance sorted reversed Exception Error Promise Array Object String Number Boolean Map Set Date JSON Math console document window");

  function detect(text) {
    const fence = /^\s*```(python|py|javascript|js|typescript|ts|html|xml|css|json|sql)\b/i.exec(text);
    if (fence) return ({ py: "python", js: "javascript", ts: "typescript", xml: "html" })[fence[1].toLowerCase()] || fence[1].toLowerCase();
    if (/^\s*(?:<\/?[a-z][\w:-]*(?:\s[^<>]*|\s*\/?)>|<!doctype\s+html|<!--)/i.test(text)) return "html";
    if (/^\s*[\[{]/.test(text)) {
      if (/^\s*[\[{]\s*$/.test(text)) return "json";
      try { const parsed = JSON.parse(text); if (parsed && typeof parsed === "object") return "json"; }
      catch { if (/"(?:\\.|[^"\\])+"\s*:/.test(text)) return "json"; }
    }
    if (/^\s*(?:async\s+def\s+|def\s+\w+\s*\(|class\s+\w+[^\n]*:|from\s+[\w.]+\s+import\b|import\s+[\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*\s*(?:#[^\n]*)?$|(?:if|elif|for|while|with|except)\b[^\n]*:|(?:try|else|finally)\s*:)/m.test(text)
      || /\b(?:print|range|len|isinstance|enumerate)\s*\(/.test(text)
      || /^#![^\n]*python/.test(text)) return "python";
    if (/\b(?:SELECT\s+[\s\S]+?\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|CREATE\s+TABLE|DELETE\s+FROM)\b/i.test(text)) return "sql";
    if (/^\s*(?:interface\s+\w+|type\s+\w+\s*=|(?:const|let)\s+\w+\s*:\s*\w+)/m.test(text)) return "typescript";
    if (/\b(?:const|let|var)\s+[\w$]+\s*=|\b(?:async\s+)?function\s*[\w$]*\s*\(|\bclass\s+\w+(?:\s+extends\s+\w+)?\s*\{|=>|\b(?:console\.(?:log|error|warn)|document\.\w+|JSON\.(?:parse|stringify))\s*\(|\b(?:import|export)\s+(?:default\b|\{|\*|[\w$]+\s+from)/.test(text)) return "javascript";
    if (/^\s*(?:[.#@][\w-][^{\n]*|[a-zA-Z][\w-]*(?:\s*[,>+~:[.#][^{\n]*)?)\s*\{\s*(?:(?:--)?[\w-]+\s*:|$)/m.test(text)) return "css";
    if (/^\s*(?:if|for|while|switch|catch)\s*\(/m.test(text)) return "javascript";
    if (/^\s*(?:SELECT|BEGIN|CASE)\s*$/i.test(text)) return "sql";
    if (/^\s*[\w$]+(?:\.[\w$]+)*\s*=(?!=)\s*\S/m.test(text) || /^\s*\w+\([^\n]*\)\s*;?\s*$/m.test(text)) return "python";
    return null;
  }

  const patterns = {
    python: /#[^\n]*|(?:[rRuUbBfF]{0,2})(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?)|\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?j?)\b|[\p{L}_$][\p{L}\p{N}_$]*/gu,
    javascript: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|`(?:\\[\s\S]|[^`\\])*`?|"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?|\b(?:0[xX][\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?)\b|[\p{L}_$][\p{L}\p{N}_$]*/gu,
    html: /<!--[\s\S]*?(?:-->|$)|<\/?[\w:-]+|\/?>|"[^"\n]*"?|'[^'\n]*'?|[\w:-]+(?=\s*=)/g,
    css: /\/\*[\s\S]*?(?:\*\/|$)|"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|#[\da-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:%|px|rem|em|vh|vw|s|ms|deg)?\b|--?[\w-]+|[\w-]+/g,
    json: /"(?:\\.|[^"\\])*"?|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
    sql: /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*'?|"(?:""|[^"])*"?|\b\d+(?:\.\d+)?\b|[\w$]+/g,
  };

  function tokenize(text, language) {
    const pattern = patterns[language === "typescript" ? "javascript" : language];
    if (!pattern) return [{ text, type: "" }];
    pattern.lastIndex = 0;
    const tokens = [];
    let end = 0;
    let previous = "";
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (match.index > end) tokens.push({ text: text.slice(end, match.index), type: "" });
      const after = text.slice(match.index + value.length, match.index + value.length + 100);
      const word = language === "sql" ? value.toLowerCase() : value;
      let type = "";
      if ((language === "python" && value.startsWith("#")) || (language === "sql" && value.startsWith("--")) || /^(?:\/\/|\/\*|<!--)/.test(value)) type = "comment";
      else if (/^(?:[rRuUbBfF]{0,2})["'`]/.test(value)) type = language === "json" && /^\s*:/.test(after) ? "variable" : "string";
      else if (/^-?\d/.test(value)) type = "number";
      else if (language === "html") type = /^<\/?\w/.test(value) ? "keyword" : /^[\w:-]/.test(value) ? "variable" : "";
      else if (language === "css") type = /^#/.test(value) ? "string" : /^\s*:/.test(after) ? "variable" : "string";
      else if (keywords[language]?.has(word) || (language === "json" && /^(?:true|false|null)$/.test(value))) type = "keyword";
      else if ((control[language] || control.javascript).has(word)) type = "control";
      else if (previous === "class" || /^[A-Z][\w$]*$/.test(value) || builtins.has(value) && !/^\s*\(/.test(after)) type = "type";
      else if (/^\s*\(/.test(after) || previous === "def" || previous === "function") type = "function";
      else if (language !== "json") type = "variable";
      tokens.push({ text: value, type });
      previous = value;
      end = match.index + value.length;
    }
    if (end < text.length) tokens.push({ text: text.slice(end), type: "" });
    return tokens;
  }

  return Object.freeze({ detect, tokenize });
})();
