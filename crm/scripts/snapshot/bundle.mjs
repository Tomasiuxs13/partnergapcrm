// Mini-bundler for the snapshot (spec 4.14, 5.1). Owner G3-6. Node only; never shipped to the browser.
//
// It turns the dashboard's native ES modules into one classic script. It only accepts the bundler-safe
// module style of spec 5.1, and checkStyle() reports every place that breaks it:
//   - relative specifiers ending in ".js" only;
//   - one import per statement: `import {a, b as c} from "./x.js"`, `import * as x from "./x.js"` or
//     `import x from "./x.js"`;
//   - exports: `export function|async function|const|class`, `export default`, `export {a, b as c}`;
//     no `export let`, `export var` or `export *`;
//   - no circular imports, no dynamic import(), no top-level await, no import.meta.
//
// Output: each module becomes `const __pg_mN = (function () { ...; return {exports}; })();`, in
// dependency order (depth first, in import order), inside one strict-mode function. Imports become
// `const {a, b: c} = __pg_mN;` at the top of the module's function. Comments are removed (a block
// comment that spanned lines leaves its line breaks), so line numbers match the source.
// Exports are plain values: the style only exports const, function and class bindings, which never change.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const KW_BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
  "case", "do", "else", "yield", "await", "export", "default"]);
const ID_START = /[A-Za-z_$À-￿]/;
const ID_PART = /[A-Za-z0-9_$À-￿]/;

/**
 * Scans JavaScript source once, string, template, regex and comment aware.
 * Returns {code, topLines, problems}:
 *   code      the source with comments removed (line breaks kept, so line numbers match)
 *   topLines  Set of 0-based line numbers whose first character is top-level code (not inside a string,
 *             template, comment, or any bracket)
 *   problems  [{line, message}] for import.meta and dynamic import() (a top-level await is found when the
 *             module's body is compiled inside a plain function: see compileProblems())
 */
export function scan(src) {
  const n = src.length;
  let out = "";
  let i = 0;
  let line = 0;
  const topLines = new Set([0]);
  const problems = [];
  const modes = [{ t: "code", d: 0 }]; // a stack: code (with its bracket depth) or a template literal
  let last = ""; // the previous significant token: "", "id", "kw", "num", "str", "regex" or "p<char>"

  const atTop = () => modes.length === 1 && modes[0].d === 0;
  const newline = () => {
    line++;
    if (atTop()) topLines.add(line);
  };
  const regexAllowed = () => last === "" || last === "kw" || (last[0] === "p" && last !== "p)" && last !== "p]");

  while (i < n) {
    const top = modes[modes.length - 1];
    const c = src[i];
    if (top.t === "tmpl") {
      if (c === "\\") {
        out += src.slice(i, i + 2);
        if (src[i + 1] === "\n") newline();
        i += 2;
      } else if (c === "`") {
        out += c;
        i++;
        modes.pop();
        last = "str";
      } else if (c === "$" && src[i + 1] === "{") {
        out += "${";
        i += 2;
        modes.push({ t: "code", d: 0, tmpl: true });
        last = "p{";
      } else {
        if (c === "\n") newline();
        out += c;
        i++;
      }
      continue;
    }
    // code
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      const body = src.slice(i, stop);
      const breaks = (body.match(/\n/g) || []).length;
      if (breaks) {
        for (let k = 0; k < breaks; k++) {
          out += "\n";
          newline();
        }
      } else out += " ";
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++;
        else if (src[j] === "\n") break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      last = "str";
      continue;
    }
    if (c === "`") {
      out += c;
      i++;
      modes.push({ t: "tmpl" });
      continue;
    }
    if (c === "/") {
      if (regexAllowed()) {
        let j = i + 1;
        let cls = false;
        while (j < n && src[j] !== "\n") {
          const ch = src[j];
          if (ch === "\\") j += 2;
          else if (ch === "[") { cls = true; j++; }
          else if (ch === "]") { cls = false; j++; }
          else if (ch === "/" && !cls) break;
          else j++;
        }
        j++;
        while (j < n && /[a-z]/.test(src[j])) j++;
        out += src.slice(i, j);
        i = j;
        last = "regex";
      } else {
        out += c;
        i++;
        last = "p/";
      }
      continue;
    }
    if (c === "{" || c === "(" || c === "[") {
      top.d++;
      out += c;
      i++;
      last = "p" + c;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      if (c === "}" && top.d === 0 && top.tmpl) {
        modes.pop();
        out += c;
        i++;
        continue;
      }
      top.d--;
      out += c;
      i++;
      last = "p" + c;
      continue;
    }
    if (c === "\n") {
      out += c;
      i++;
      newline();
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      out += c;
      i++;
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(src[j])) j++;
      const word = src.slice(i, j);
      const afterDot = last === "p.";
      out += word;
      i = j;
      if (!afterDot) {
        if (word === "import") {
          const rest = src.slice(j, j + 40);
          if (/^\s*\.\s*meta\b/.test(rest)) problems.push({ line: line + 1, message: "import.meta" });
          else if (/^\s*\(/.test(rest)) problems.push({ line: line + 1, message: "dynamic import()" });
        }
      }
      last = !afterDot && KW_BEFORE_REGEX.has(word) ? "kw" : "id";
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j])) j++;
      out += src.slice(i, j);
      i = j;
      last = "num";
      continue;
    }
    out += c;
    i++;
    last = "p" + c;
  }
  return { code: out, topLines, problems };
}

const IMPORT_RE = /^import\s+(?:(\*\s+as\s+([A-Za-z_$][\w$]*))|([A-Za-z_$][\w$]*)|\{([^}]*)\})\s*from\s*(["'])([^"'\n]*)\5[ \t]*;?/;
const BAD_IMPORT_RE = /^import\b/;
const EXPORT_DECL_RE = /^export\s+(async\s+function\s*\*?|function\s*\*?|const|class)\s+([A-Za-z_$][\w$]*)/;
const EXPORT_DEFAULT_RE = /^export\s+default\s+/;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}[ \t]*;?/;

function parseSpecList(list, where, problems) {
  const out = [];
  for (const part of list.split(",")) {
    const s = part.trim();
    if (!s) continue;
    const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(s);
    if (!m) {
      problems.push({ line: where, message: "unsupported name list item: " + s });
      continue;
    }
    out.push({ local: m[1], name: m[2] || m[1] });
  }
  return out;
}

/**
 * Parses one module. Returns {code, imports, exports, edits, problems}:
 *   imports  [{spec, kind: 'named'|'ns'|'default', names: [{local, name}], local, start, end, line}]
 *   exports  [{name, local}]   ('default' -> local '__pg_default')
 *   edits    [{start, end, text}] replacements in `code` for export keywords and import statements
 *   problems [{line, message}] (an empty list means the module follows the style rules)
 */
export function parseModule(src) {
  const { code, topLines, problems } = scan(src);
  const imports = [];
  const exports = [];
  const edits = [];
  let offset = 0;
  const lines = code.split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    const text = lines[ln];
    const start = offset;
    offset += text.length + 1;
    if (!topLines.has(ln)) continue;
    if (text.startsWith("import")) {
      const rest = code.slice(start);
      const m = IMPORT_RE.exec(rest);
      if (!m) {
        if (BAD_IMPORT_RE.test(text) && !/^import\s*[.(]/.test(text)) {
          problems.push({ line: ln + 1, message: "unsupported import form: " + text.trim().slice(0, 80) });
        }
        continue;
      }
      const spec = m[6];
      const imp = { spec, start, end: start + m[0].length, line: ln + 1 };
      if (m[1]) { imp.kind = "ns"; imp.local = m[2]; }
      else if (m[3]) { imp.kind = "default"; imp.local = m[3]; }
      else {
        // `import {a as b}`: a is the imported name, b the local binding.
        imp.kind = "named";
        imp.names = parseSpecList(m[4], ln + 1, problems).map((x) => ({ name: x.local, local: x.name }));
      }
      if (!/^\.\.?\//.test(spec) || !spec.endsWith(".js")) {
        problems.push({ line: ln + 1, message: "specifier must be relative and end in .js: " + spec });
      }
      imports.push(imp);
      continue;
    }
    if (text.startsWith("export")) {
      const rest = code.slice(start);
      let m = EXPORT_DECL_RE.exec(rest);
      if (m) {
        if (/^export\s+const\s*[{[]/.test(rest)) problems.push({ line: ln + 1, message: "export const with destructuring" });
        exports.push({ name: m[2], local: m[2] });
        edits.push({ start, end: start + "export".length, text: "      " });
        continue;
      }
      if (/^export\s+const\s*[{[]/.test(rest)) {
        problems.push({ line: ln + 1, message: "export const with destructuring" });
        continue;
      }
      m = EXPORT_DEFAULT_RE.exec(rest);
      if (m) {
        const after = rest.slice(m[0].length);
        const named = /^(async\s+function\s*\*?|function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/.exec(after);
        if (named) {
          exports.push({ name: "default", local: named[2] });
          edits.push({ start, end: start + m[0].length, text: "" });
        } else {
          exports.push({ name: "default", local: "__pg_default" });
          edits.push({ start, end: start + m[0].length, text: "const __pg_default = " });
        }
        continue;
      }
      m = EXPORT_LIST_RE.exec(rest);
      if (m) {
        for (const x of parseSpecList(m[1], ln + 1, problems)) exports.push({ name: x.name, local: x.local });
        edits.push({ start, end: start + m[0].length, text: "" });
        if (/^export\s*\{[^}]*\}\s*from\b/.test(rest)) problems.push({ line: ln + 1, message: "export ... from is not allowed" });
        continue;
      }
      if (/^export\s+(let|var)\b/.test(rest)) problems.push({ line: ln + 1, message: "export let/var is not allowed" });
      else if (/^export\s*\*/.test(rest)) problems.push({ line: ln + 1, message: "export * is not allowed" });
      else problems.push({ line: ln + 1, message: "unsupported export form: " + text.trim().slice(0, 80) });
    }
  }
  const seen = new Set();
  for (const e of exports) {
    if (seen.has(e.name)) problems.push({ line: 0, message: "duplicate export " + e.name });
    seen.add(e.name);
  }
  for (const imp of imports) edits.push({ start: imp.start, end: imp.end, text: "" });
  return { code, imports, exports, edits, problems };
}

function applyEdits(code, edits) {
  const sorted = edits.slice().sort((a, b) => b.start - a.start);
  let out = code;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

// The module's body as the bundle runs it: inside a plain (not async) strict function, with its imports
// and export keywords gone. A stray import or export statement, or any other syntax the bundle can't run,
// is a SyntaxError here. The body is also compiled as a class static block, where `await` is reserved
// outside nested functions: that catches every top-level await, including `await(x)`, which a plain
// function would read as a call. Returns [{line, message}].
export function compileProblems(mod) {
  const body = applyEdits(mod.code, mod.edits);
  const tries = [
    ["(function () {\"use strict\";\n", "\n})", 1, "doesn't compile inside the bundle: "],
    ["(class {\nstatic {\n", "\n}\n})", 2, "top-level await is not allowed: "],
  ];
  for (const [head, tail, shift, label] of tries) {
    try {
      new vm.Script(head + body + tail, { filename: "module.js" });
    } catch (e) {
      const m = /module\.js:(\d+)/.exec(String(e && e.stack));
      return [{ line: m ? Number(m[1]) - shift : 0, message: label + (e && e.message) }];
    }
  }
  return [];
}

/** Style problems of one file as readable lines ("path:line message"). */
export function checkStyle(file, src = fs.readFileSync(file, "utf8")) {
  const mod = parseModule(src);
  const problems = mod.problems.concat(mod.problems.length ? [] : compileProblems(mod));
  return problems.map((p) => file + ":" + p.line + " " + p.message);
}

/**
 * Reads the module graph from `entry`. swap: {absolute path of a module: absolute path of its stand-in}
 * (a stand-in's own imports are never swapped back to itself). Returns {order, modules, problems}:
 * order is the evaluation order (dependencies first), modules a Map(path -> parsed module).
 */
export function graph(entry, { swap = {} } = {}) {
  const modules = new Map();
  const order = [];
  const problems = [];
  const state = new Map(); // path -> 'visiting' | 'done'
  const swapOf = (p, from) => {
    const s = swap[p];
    return s && s !== from ? s : p;
  };
  const visit = (file, chain) => {
    const st = state.get(file);
    if (st === "done") return;
    if (st === "visiting") {
      problems.push("circular import: " + chain.concat(file).map((f) => path.basename(f)).join(" -> "));
      return;
    }
    state.set(file, "visiting");
    let src;
    try {
      src = fs.readFileSync(file, "utf8");
    } catch (e) {
      problems.push("missing module: " + file + (chain.length ? " (imported by " + chain[chain.length - 1] + ")" : ""));
      state.set(file, "done");
      return;
    }
    if (src.includes("__pg_")) problems.push(file + ": uses the reserved prefix __pg_");
    const mod = parseModule(src);
    mod.file = file;
    for (const p of mod.problems.concat(mod.problems.length ? [] : compileProblems(mod))) {
      problems.push(file + ":" + p.line + " " + p.message);
    }
    for (const imp of mod.imports) {
      imp.target = swapOf(path.resolve(path.dirname(file), imp.spec), file);
      visit(imp.target, chain.concat(file));
    }
    modules.set(file, mod);
    state.set(file, "done");
    order.push(file);
  };
  visit(path.resolve(entry), []);
  // Every imported name must exist in the module that provides it (as a real ES module link would check).
  for (const file of order) {
    const mod = modules.get(file);
    for (const imp of mod.imports) {
      const dep = modules.get(imp.target);
      if (!dep) continue;
      const names = new Set(dep.exports.map((e) => e.name));
      if (imp.kind === "default" && !names.has("default")) problems.push(file + ":" + imp.line + " " + imp.spec + " has no default export");
      if (imp.kind === "named") {
        for (const x of imp.names) if (!names.has(x.name)) problems.push(file + ":" + imp.line + " " + imp.spec + " does not export " + x.name);
      }
    }
  }
  return { order, modules, problems };
}

const ident = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

/**
 * Bundles `entry` and its imports into one classic script (a string). Options:
 *   swap     {absolute module path: absolute stand-in path}
 *   root     paths in the "// file" headers are shown relative to it
 *   expose   a global name: the entry's exports are assigned to globalThis[expose] (used by the tests)
 * Throws an Error listing every problem when the graph breaks the style rules.
 */
export function bundle(entry, { swap = {}, root = process.cwd(), expose = "" } = {}) {
  const g = graph(entry, { swap });
  if (g.problems.length) {
    const err = new Error("The modules don't follow the bundler-safe style (spec 5.1):\n  " + g.problems.join("\n  "));
    err.problems = g.problems;
    throw err;
  }
  const ids = new Map(g.order.map((f, k) => [f, "__pg_m" + k]));
  const parts = ['(function () {\n"use strict";\n'];
  for (const file of g.order) {
    const mod = g.modules.get(file);
    const head = [];
    for (const imp of mod.imports) {
      const id = ids.get(imp.target);
      if (imp.kind === "ns") head.push("const " + imp.local + " = " + id + ";");
      else if (imp.kind === "default") head.push("const " + imp.local + " = " + id + ".default;");
      else if (imp.names.length) {
        head.push("const { " + imp.names.map((x) => (x.name === x.local ? x.local : ident(x.name) + ": " + x.local)).join(", ") + " } = " + id + ";");
      }
    }
    const body = applyEdits(mod.code, mod.edits);
    const ret = "return { " + mod.exports.map((e) => ident(e.name) + ": " + e.local).join(", ") + " };";
    const rel = path.relative(root, file).split(path.sep).join("/");
    parts.push("// " + rel + "\nconst " + ids.get(file) + " = (function () {\n" + head.join("\n") + "\n" + body + "\n" + ret + "\n})();\n");
  }
  if (expose) parts.push("globalThis[" + JSON.stringify(expose) + "] = " + ids.get(g.order[g.order.length - 1]) + ";\n");
  parts.push("})();\n");
  return { code: parts.join(""), order: g.order, modules: g.modules };
}
