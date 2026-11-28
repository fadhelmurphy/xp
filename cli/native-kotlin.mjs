// Komponen @xp/runtime → kode Kotlin (Android), supaya di app rilis komponen jalan sebagai kode
// native: tanpa engine JS, tanpa JSON di antara logika dan UI.
//
// Cara kerja:
//   1. esbuild membundle komponen beserta import lokalnya jadi satu modul JS. Import @xp/runtime
//      diganti modul kecil yang mengambil hooks dan jsx dari objek `__xp` milik runtime Kotlin.
//   2. AST modul itu diterjemahkan pernyataan per pernyataan ke Kotlin. Nilai JS diwakili
//      Any? (Double, String, Boolean, JsObject, JsArray, JsFunction); operator JS lewat helper `Js`.
//   3. Hasilnya `object` yang mengimplementasikan XPCompiledComponent, dijalankan oleh
//      XPComponentRuntime (port runtime JS ke Kotlin) dan dirender oleh Compose yang sama.
//
// Fitur JS yang tidak bisa diterjemahkan (class, async, generator, getter, ...) membuat build gagal
// dengan pesan yang menyebut file, baris, dan alasannya.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";

const PRIMITIVES = ["View", "Text", "Image", "Pressable", "ScrollView", "TextInput", "Modal", "NativeView"];
const RUNTIME_API = [
  "useState", "useEffect", "useMemo", "useCallback", "useRef", "createElement", "Fragment",
  "environment", "registerBreakpoints",
];

// Global JS yang tersedia di runtime Kotlin.
export const GLOBALS = new Set([
  "Math", "Object", "Array", "JSON", "Number", "String", "Boolean", "console", "Date", "Error", "TypeError",
  "Set", "Map", "NaN", "Infinity", "parseInt", "parseFloat", "isNaN", "isFinite",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval", "__xp",
]);

const KOTLIN_RUNTIME_MODULE = `
${PRIMITIVES.map((p) => `export const ${p} = ${JSON.stringify(p)};`).join("\n")}
${RUNTIME_API.map((n) => `export const ${n} = __xp.${n};`).join("\n")}
export const jsx = __xp.jsx;
export const jsxs = __xp.jsx;
export const jsxDEV = __xp.jsx;
`;

export class NativeCompileError extends Error {}

/** Nama object Kotlin untuk komponen, mis. "promo-modal" → "XP_PromoModal". */
export function kotlinName(name) {
  return "XP_" + name.split(/[^A-Za-z0-9]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join("");
}

/** Bundle komponen jadi satu modul ESM tanpa import, plus sourcemap untuk pesan error. */
export async function bundleForNative(file, extraPlugins = []) {
  const result = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "esnext",
    jsx: "automatic",
    jsxImportSource: "@xp/runtime",
    minify: false,
    treeShaking: true,
    sourcemap: "external",
    outdir: path.join(path.dirname(file), ".xp-native"),
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
    plugins: [
      ...extraPlugins,
      {
        name: "xp-kotlin-runtime",
        setup(b) {
          b.onResolve({ filter: /^@xp\/runtime(\/.*)?$/ }, () => ({ path: "runtime", namespace: "xp-kotlin" }));
          b.onLoad({ filter: /.*/, namespace: "xp-kotlin" }, () => ({ contents: KOTLIN_RUNTIME_MODULE, loader: "js" }));
          // CSS (tema Tailwind) tidak ikut kode native.
          b.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
        },
      },
    ],
  });
  const js = result.outputFiles.find((f) => f.path.endsWith(".js")).text;
  const map = JSON.parse(result.outputFiles.find((f) => f.path.endsWith(".map")).text);
  return { js, map };
}

// --- sourcemap: posisi di bundle → file asli ---

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function decodeMappings(mappings) {
  const lines = [];
  let src = 0, oLine = 0, oCol = 0;
  for (const line of mappings.split(";")) {
    const segs = [];
    let col = 0;
    for (const seg of line.split(",")) {
      if (!seg) continue;
      const vals = [];
      let shift = 0, value = 0;
      for (const ch of seg) {
        const d = B64.indexOf(ch);
        value += (d & 31) << shift;
        if (d & 32) shift += 5;
        else {
          vals.push(value & 1 ? -(value >> 1) : value >> 1);
          value = 0;
          shift = 0;
        }
      }
      col += vals[0];
      if (vals.length >= 4) {
        src += vals[1];
        oLine += vals[2];
        oCol += vals[3];
        segs.push([col, src, oLine, oCol]);
      }
    }
    lines.push(segs);
  }
  return lines;
}

export function originalPosition(map, decoded, line, col, projectDir) {
  const segs = decoded[line] ?? [];
  let best = null;
  for (const s of segs) if (s[0] <= col) best = s;
  if (!best) best = segs[0];
  if (!best) return null;
  const source = path.resolve(path.dirname(map.file ?? "."), map.sources[best[1]]);
  return `${path.relative(projectDir, source).split(path.sep).join("/")}:${best[2] + 1}:${best[3] + 1}`;
}

// --- pembangkit kode ---

const KOTLIN_KEYWORDS = new Set(["as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface", "is", "null", "object", "package", "return", "super", "this", "throw", "true", "try", "typealias", "typeof", "val", "var", "when", "while"]);

function kstr(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "$") out += "\\$";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || (c >= 0x7f && c < 0xa0) || c === 0x2028 || c === 0x2029) out += "\\u" + c.toString(16).padStart(4, "0");
    else if (c > 0xffff) {
      const hi = Math.floor((c - 0x10000) / 0x400) + 0xd800, lo = ((c - 0x10000) % 0x400) + 0xdc00;
      out += "\\u" + hi.toString(16) + "\\u" + lo.toString(16);
    } else out += ch;
  }
  return out + '"';
}

function knum(n) {
  if (Number.isNaN(n)) return "Double.NaN";
  if (n === Infinity) return "Double.POSITIVE_INFINITY";
  if (n === -Infinity) return "Double.NEGATIVE_INFINITY";
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return `${n}.0`;
  const s = String(n);
  return /[.e]/.test(s) ? s.replace("e+", "e") : `${s}.0`;
}

export class Scope {
  constructor(parent, fn = false) {
    this.parent = parent;
    this.fn = fn;
    this.names = new Map(); // nama JS → nama Kotlin
  }
  declare(name, k) {
    if (!this.names.has(name)) this.names.set(name, k);
    return this.names.get(name);
  }
  lookup(name) {
    for (let s = this; s; s = s.parent) if (s.names.has(name)) return s.names.get(name);
    return null;
  }
  fnScope() {
    let s = this;
    while (s && !s.fn) s = s.parent;
    return s;
  }
}

class KotlinEmitter {
  constructor(sf, fail) {
    this.sf = sf;
    this.fail = fail;
    this.counter = 0;
    this.usedGlobals = new Set();
    this.defaultExport = null;
    this.fnLabels = []; // label lambda function yang sedang dikompilasi
    this.loops = []; // { label, update, jsLabel, kind }
  }

  id(prefix = "t") {
    return `${prefix}${++this.counter}`;
  }

  kname(name) {
    const clean = name.replace(/\$/g, "_S");
    return KOTLIN_KEYWORDS.has(clean) ? `j_${clean}_` : `j_${clean}`;
  }

  error(node, reason) {
    this.fail(node, reason);
    return "null";
  }

  // --- deklarasi & hoisting ---

  bindingNames(name, out = []) {
    if (ts.isIdentifier(name)) out.push(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) if (!ts.isOmittedExpression(el)) this.bindingNames(el.name, out);
    }
    return out;
  }

  /** `var` di seluruh badan fungsi (tidak masuk ke fungsi lain): di-hoist ke awal fungsi. */
  collectVars(node, out = []) {
    const visit = (n) => {
      if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
      if (ts.isVariableDeclarationList(n) && !(n.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
        for (const d of n.declarations) this.bindingNames(d.name, out);
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(node, visit);
    return out;
  }

  /** let/const/function yang dideklarasikan langsung di blok ini. */
  blockDecls(statements) {
    const lets = [], fns = [];
    for (const st of statements) {
      if (ts.isVariableStatement(st) && st.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) {
        for (const d of st.declarationList.declarations) this.bindingNames(d.name, lets);
      } else if (ts.isFunctionDeclaration(st) && st.name) {
        fns.push(st);
      } else if (ts.isClassDeclaration(st)) {
        this.fail(st, "class belum didukung di target native");
      }
    }
    return { lets, fns };
  }

  /** Pembuka blok: deklarasi Kotlin + inisialisasi fungsi (hoisting seperti JS). */
  openBlock(statements, scope, out, indent) {
    const { lets, fns } = this.blockDecls(statements);
    for (const n of lets) {
      if (scope.names.has(n)) continue;
      out.push(`${indent}var ${scope.declare(n, this.kname(n))}: Any? = null`);
    }
    for (const f of fns) {
      const n = f.name.text;
      if (!scope.names.has(n)) out.push(`${indent}var ${scope.declare(n, this.kname(n))}: Any? = null`);
    }
    for (const f of fns) out.push(`${indent}${scope.lookup(f.name.text)} = ${this.fn(f, scope, indent)}`);
  }

  // --- modul ---

  module() {
    const scope = new Scope(null, true);
    const body = [];
    const ind = "        ";
    for (const n of this.collectVars(this.sf)) {
      if (!scope.names.has(n)) body.push(`${ind}var ${scope.declare(n, this.kname(n))}: Any? = null`);
    }
    const statements = this.sf.statements.filter((s) => !ts.isImportDeclaration(s));
    for (const s of this.sf.statements) if (ts.isImportDeclaration(s)) this.fail(s, "import yang tersisa setelah bundle");
    this.openBlock(statements, scope, body, ind);
    for (const st of statements) this.statement(st, scope, body, ind);
    if (!this.defaultExport) this.fail(this.sf, "komponen harus punya export default");
    return { body, scope };
  }

  // --- pernyataan ---

  statement(st, scope, out, ind) {
    const S = ts.SyntaxKind;
    switch (st.kind) {
      case S.VariableStatement:
        for (const d of st.declarationList.declarations) {
          if (!d.initializer) {
            if (st.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) {
              for (const n of this.bindingNames(d.name)) out.push(`${ind}${scope.lookup(n)} = null`);
            }
            continue;
          }
          this.assignPattern(d.name, this.expr(d.initializer, scope), scope, out, ind);
        }
        return;
      case S.FunctionDeclaration:
        return; // sudah di-hoist di openBlock
      case S.ExpressionStatement:
        return this.exprStatement(st.expression, scope, out, ind);
      case S.ReturnStatement: {
        const label = this.fnLabels.at(-1);
        if (!label) return void this.fail(st, "return di luar function");
        out.push(`${ind}return@${label} ${st.expression ? this.expr(st.expression, scope) : "null"}`);
        return;
      }
      case S.IfStatement: {
        out.push(`${ind}if (${this.cond(st.expression, scope)}) {`);
        this.nested(st.thenStatement, scope, out, ind + "    ");
        if (st.elseStatement) {
          out.push(`${ind}} else {`);
          this.nested(st.elseStatement, scope, out, ind + "    ");
        }
        out.push(`${ind}}`);
        return;
      }
      case S.Block:
        this.nested(st, scope, out, ind, true);
        return;
      case S.EmptyStatement:
      case S.DebuggerStatement:
        return;
      case S.ThrowStatement:
        out.push(`${ind}Js.throwValue(${this.expr(st.expression, scope)})`);
        return;
      case S.TryStatement: {
        out.push(`${ind}try {`);
        this.nested(st.tryBlock, scope, out, ind + "    ");
        if (st.catchClause) {
          const e = this.id("e");
          out.push(`${ind}} catch (${e}: Throwable) {`);
          const inner = new Scope(scope);
          const decl = st.catchClause.variableDeclaration;
          const body = [];
          if (decl) {
            if (ts.isIdentifier(decl.name)) body.push(`${ind}    var ${inner.declare(decl.name.text, this.kname(decl.name.text))}: Any? = Js.caught(${e})`);
            else {
              for (const n of this.bindingNames(decl.name)) body.push(`${ind}    var ${inner.declare(n, this.kname(n))}: Any? = null`);
              this.assignPattern(decl.name, `Js.caught(${e})`, inner, body, ind + "    ");
            }
          }
          this.blockInto(st.catchClause.block.statements, inner, body, ind + "    ");
          out.push(...body);
        }
        if (st.finallyBlock) {
          out.push(`${ind}} finally {`);
          this.nested(st.finallyBlock, scope, out, ind + "    ");
        }
        out.push(`${ind}}`);
        return;
      }
      case S.ForStatement:
        return this.forStatement(st, scope, out, ind);
      case S.ForOfStatement:
      case S.ForInStatement:
        return this.forOf(st, scope, out, ind);
      case S.WhileStatement: {
        const label = this.id("L");
        out.push(`${ind}${label}@ while (${this.cond(st.expression, scope)}) {`);
        this.loopBody(st.statement, { label, update: null }, scope, out, ind + "    ");
        out.push(`${ind}}`);
        return;
      }
      case S.DoStatement: {
        const label = this.id("L");
        out.push(`${ind}${label}@ do {`);
        this.loopBody(st.statement, { label, update: null }, scope, out, ind + "    ");
        out.push(`${ind}} while (${this.cond(st.expression, scope)})`);
        return;
      }
      case S.BreakStatement:
      case S.ContinueStatement: {
        const isBreak = st.kind === S.BreakStatement;
        const target = st.label
          ? this.loops.findLast((l) => l.jsLabel === st.label.text)
          : this.loops.findLast((l) => isBreak || l.kind !== "switch");
        if (!target) return void this.fail(st, `${isBreak ? "break" : "continue"} di luar loop`);
        if (!isBreak && target.update) out.push(`${ind}${target.update}`);
        out.push(`${ind}${isBreak ? "break" : "continue"}@${target.label}`);
        return;
      }
      case S.LabeledStatement: {
        const inner = st.statement;
        if (!ts.isIterationStatement(inner, false) && !ts.isSwitchStatement(inner)) {
          return void this.fail(st, "label hanya didukung di loop");
        }
        this.pendingLabel = st.label.text;
        return this.statement(inner, scope, out, ind);
      }
      case S.SwitchStatement:
        return this.switchStatement(st, scope, out, ind);
      case S.ExportDeclaration: {
        if (st.exportClause && ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) {
            if (el.name.text === "default") {
              const local = (el.propertyName ?? el.name).text;
              this.defaultExport = scope.lookup(local) ?? this.fail(st, `export default '${local}' tidak ditemukan`);
            }
          }
        }
        return;
      }
      case S.ExportAssignment: {
        const tmp = scope.declare("__default", "j___default");
        out.push(`${ind}var ${tmp}: Any? = ${this.expr(st.expression, scope)}`);
        this.defaultExport = tmp;
        return;
      }
      case S.ClassDeclaration:
        return void this.fail(st, "class belum didukung di target native");
      default:
        this.fail(st, `pernyataan ${S[st.kind]} belum didukung di target native`);
    }
  }

  takeLabel() {
    const l = this.pendingLabel;
    this.pendingLabel = null;
    return l ?? null;
  }

  /** Badan if/loop: blok baru dengan scope sendiri. */
  nested(st, scope, out, ind, braces = false) {
    const inner = new Scope(scope);
    const statements = ts.isBlock(st) ? st.statements : [st];
    if (braces) {
      // Blok bebas `{ ... }`: run {} supaya deklarasinya tidak bentrok.
      out.push(`${ind}run {`);
      this.blockInto(statements, inner, out, ind + "    ");
      out.push(`${ind}}`);
    } else {
      this.blockInto(statements, inner, out, ind);
    }
  }

  blockInto(statements, scope, out, ind) {
    this.openBlock(statements, scope, out, ind);
    for (const s of statements) this.statement(s, scope, out, ind);
  }

  loopBody(body, loop, scope, out, ind) {
    loop.jsLabel = this.takeLabel();
    this.loops.push(loop);
    this.nested(body, scope, out, ind);
    this.loops.pop();
  }

  forStatement(st, scope, out, ind) {
    const label = this.id("L");
    const inner = new Scope(scope);
    out.push(`${ind}run {`);
    const ind2 = ind + "    ";
    if (st.initializer) {
      if (ts.isVariableDeclarationList(st.initializer)) {
        for (const d of st.initializer.declarations) {
          for (const n of this.bindingNames(d.name)) {
            if (!inner.lookup(n) || st.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) {
              out.push(`${ind2}var ${inner.declare(n, this.kname(n))}: Any? = null`);
            }
          }
          if (d.initializer) this.assignPattern(d.name, this.expr(d.initializer, inner), inner, out, ind2);
        }
      } else {
        this.exprStatement(st.initializer, inner, out, ind2);
      }
    }
    const update = st.incrementor ? this.exprStatementInline(st.incrementor, inner) : null;
    out.push(`${ind2}${label}@ while (${st.condition ? this.cond(st.condition, inner) : "true"}) {`);
    this.loopBody(st.statement, { label, update }, inner, out, ind2 + "    ");
    if (update) out.push(`${ind2}    ${update}`);
    out.push(`${ind2}}`);
    out.push(`${ind}}`);
  }

  forOf(st, scope, out, ind) {
    const label = this.id("L");
    const item = this.id("it");
    const src = ts.isForOfStatement(st) ? `Js.iter(${this.expr(st.expression, scope)})` : `Js.keys(${this.expr(st.expression, scope)})`;
    if (ts.isForOfStatement(st) && st.awaitModifier) return void this.fail(st, "for await belum didukung");
    out.push(`${ind}${label}@ for (${item} in ${src}) {`);
    const inner = new Scope(scope);
    const ind2 = ind + "    ";
    const init = st.initializer;
    if (ts.isVariableDeclarationList(init)) {
      const d = init.declarations[0];
      for (const n of this.bindingNames(d.name)) out.push(`${ind2}var ${inner.declare(n, this.kname(n))}: Any? = null`);
      this.assignPattern(d.name, item, inner, out, ind2);
    } else {
      out.push(`${ind2}${this.assignTo(init, item, inner)}`);
    }
    this.loopBody(st.statement, { label, update: null }, inner, out, ind2);
    out.push(`${ind}}`);
  }

  switchStatement(st, scope, out, ind) {
    const label = this.id("S");
    const d = this.id("d");
    const idx = this.id("i");
    out.push(`${ind}${label}@ do {`);
    const ind2 = ind + "    ";
    out.push(`${ind2}val ${d} = ${this.expr(st.expression, scope)}`);
    const clauses = st.caseBlock.clauses;
    const defaultIndex = clauses.findIndex((c) => ts.isDefaultClause(c));
    const cases = clauses
      .map((c, i) => (ts.isCaseClause(c) ? `${ind2}    Js.seq(${d}, ${this.expr(c.expression, scope)}) -> ${i}` : null))
      .filter(Boolean);
    out.push(`${ind2}val ${idx} = when {`);
    out.push(...cases);
    out.push(`${ind2}    else -> ${defaultIndex}`);
    out.push(`${ind2}}`);
    const inner = new Scope(scope);
    const all = clauses.flatMap((c) => c.statements);
    this.openBlock(all, inner, out, ind2);
    this.loops.push({ label, update: null, kind: "switch", jsLabel: this.takeLabel() });
    clauses.forEach((c, i) => {
      if (!c.statements.length) return;
      out.push(`${ind2}if (${idx} in 0..${i}) {`);
      for (const s of c.statements) this.statement(s, inner, out, ind2 + "    ");
      out.push(`${ind2}}`);
    });
    this.loops.pop();
    out.push(`${ind}} while (false)`);
  }

  // --- pola (destructuring) ---

  /** Isi variabel dari `value` sesuai pola (identifier, {a, b = 1, ...rest}, [x, y]). */
  assignPattern(name, value, scope, out, ind) {
    if (ts.isIdentifier(name)) {
      out.push(`${ind}${scope.lookup(name.text) ?? this.error(name, `'${name.text}' tidak dideklarasikan`)} = ${value}`);
      return;
    }
    const tmp = this.id("p");
    out.push(`${ind}val ${tmp} = ${value}`);
    if (ts.isObjectBindingPattern(name)) {
      const taken = [];
      for (const el of name.elements) {
        if (el.dotDotDotToken) {
          out.push(`${ind}${scope.lookup(el.name.text)} = Js.omit(${tmp}, listOf(${taken.join(", ")}))`);
          continue;
        }
        const keyNode = el.propertyName ?? el.name;
        const key = ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode) ? kstr(keyNode.text)
          : ts.isComputedPropertyName(keyNode) ? `Js.key(${this.expr(keyNode.expression, scope)})`
          : ts.isNumericLiteral(keyNode) ? kstr(String(Number(keyNode.text))) : this.error(keyNode, "kunci pola tidak didukung");
        taken.push(key);
        let v = `Js.get(${tmp}, ${key})`;
        if (el.initializer) v = `(${v} ?: ${this.expr(el.initializer, scope)})`;
        this.assignPattern(el.name, v, scope, out, ind);
      }
    } else {
      name.elements.forEach((el, i) => {
        if (ts.isOmittedExpression(el)) return;
        if (el.dotDotDotToken) {
          this.assignPattern(el.name, `JsArray(Js.iter(${tmp}).drop(${i}))`, scope, out, ind);
          return;
        }
        let v = `Js.get(${tmp}, ${knum(i)})`;
        if (el.initializer) v = `(${v} ?: ${this.expr(el.initializer, scope)})`;
        this.assignPattern(el.name, v, scope, out, ind);
      });
    }
  }

  // --- fungsi ---

  fn(node, scope, ind) {
    if (node.asteriskToken) return this.error(node, "generator belum didukung di target native");
    if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return this.error(node, "async/await belum didukung di target native");
    const label = this.id("f");
    const args = this.id("a");
    const inner = new Scope(scope, true);
    const ind2 = ind + "    ";
    const body = [];
    const name = node.name && ts.isIdentifier(node.name) ? node.name.text : "";
    // fungsi bernama sebagai ekspresi bisa memanggil dirinya sendiri
    let selfRef = null;
    if (name && (ts.isFunctionExpression(node))) selfRef = inner.declare(name, this.kname(name) + "_self");
    node.parameters.forEach((p, i) => {
      for (const n of this.bindingNames(p.name)) body.push(`${ind2}var ${inner.declare(n, this.kname(n))}: Any? = null`);
      let v = p.dotDotDotToken ? `JsArray(${args}.drop(${i}))` : `${args}.getOrNull(${i})`;
      if (p.initializer) v = `(${v} ?: ${this.expr(p.initializer, inner)})`;
      this.assignPattern(p.name, v, inner, body, ind2);
    });
    this.fnLabels.push(label);
    const loops = this.loops;
    this.loops = [];
    if (ts.isBlock(node.body)) {
      for (const n of this.collectVars(node.body)) {
        if (!inner.names.has(n)) body.push(`${ind2}var ${inner.declare(n, this.kname(n))}: Any? = null`);
      }
      this.blockInto(node.body.statements, inner, body, ind2);
      body.push(`${ind2}null`);
    } else {
      body.push(`${ind2}${this.expr(node.body, inner)}`);
    }
    this.loops = loops;
    this.fnLabels.pop();
    const lambda = `JsFunction(${kstr(name)}) ${label}@{ ${args} ->\n${body.join("\n")}\n${ind}}`;
    if (selfRef) return `run { var ${selfRef}: Any? = null; ${selfRef} = ${lambda}; ${selfRef} }`;
    return lambda;
  }

  // --- ekspresi ---

  cond(e, scope) {
    // Ekspresi yang hasilnya sudah Boolean tidak perlu Js.truthy.
    const k = this.boolExpr(e, scope);
    return k ?? `Js.truthy(${this.expr(e, scope)})`;
  }

  /** Bentuk Boolean Kotlin untuk perbandingan/negasi/&&/||; null kalau bukan ekspresi boolean. */
  boolExpr(e, scope) {
    const S = ts.SyntaxKind;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isPrefixUnaryExpression(e) && e.operator === S.ExclamationToken) return `!(${this.cond(e.operand, scope)})`;
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      const l = () => this.expr(e.left, scope), r = () => this.expr(e.right, scope);
      switch (op) {
        case S.EqualsEqualsEqualsToken: return `Js.seq(${l()}, ${r()})`;
        case S.ExclamationEqualsEqualsToken: return `!Js.seq(${l()}, ${r()})`;
        case S.EqualsEqualsToken: return `Js.eq(${l()}, ${r()})`;
        case S.ExclamationEqualsToken: return `!Js.eq(${l()}, ${r()})`;
        case S.LessThanToken: return `Js.lt(${l()}, ${r()})`;
        case S.GreaterThanToken: return `Js.gt(${l()}, ${r()})`;
        case S.LessThanEqualsToken: return `Js.le(${l()}, ${r()})`;
        case S.GreaterThanEqualsToken: return `Js.ge(${l()}, ${r()})`;
        case S.AmpersandAmpersandToken: return `(${this.cond(e.left, scope)} && ${this.cond(e.right, scope)})`;
        case S.BarBarToken: return `(${this.cond(e.left, scope)} || ${this.cond(e.right, scope)})`;
        case S.InKeyword: return `Js.hasKey(${l()}, ${r()})`;
        default: return null;
      }
    }
    return null;
  }

  exprStatement(e, scope, out, ind) {
    out.push(`${ind}${this.exprStatementInline(e, scope)}`);
  }

  /** Ekspresi sebagai pernyataan (tanpa nilai): assignment dan ++ jadi bentuk Kotlin langsung. */
  exprStatementInline(e, scope) {
    const S = ts.SyntaxKind;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === S.EqualsToken) {
        if (ts.isObjectLiteralExpression(e.left) || ts.isArrayLiteralExpression(e.left)) {
          return this.error(e, "destructuring assignment belum didukung; pakai const { ... } = ...");
        }
        return this.assignTo(e.left, this.expr(e.right, scope), scope);
      }
      const compound = COMPOUND[op];
      if (compound) return this.assignTo(e.left, compound(this.expr(e.left, scope), this.expr(e.right, scope)), scope);
      if (op === S.CommaToken) return `${this.exprStatementInline(e.left, scope)}; ${this.exprStatementInline(e.right, scope)}`;
      if (op === S.AmpersandAmpersandToken) return `if (${this.cond(e.left, scope)}) { ${this.exprStatementInline(e.right, scope)} }`;
      if (op === S.BarBarToken) return `if (!(${this.cond(e.left, scope)})) { ${this.exprStatementInline(e.right, scope)} }`;
      if (op === S.QuestionQuestionEqualsToken || op === S.BarBarEqualsToken || op === S.AmpersandAmpersandEqualsToken) {
        return this.expr(e, scope);
      }
    }
    if ((ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) && (e.operator === S.PlusPlusToken || e.operator === S.MinusMinusToken)) {
      const delta = e.operator === S.PlusPlusToken ? "+" : "-";
      return this.assignTo(e.operand, `(Js.toNum(${this.expr(e.operand, scope)}) ${delta} 1.0)`, scope);
    }
    if (ts.isConditionalExpression(e)) {
      return `if (${this.cond(e.condition, scope)}) { ${this.exprStatementInline(e.whenTrue, scope)} } else { ${this.exprStatementInline(e.whenFalse, scope)} }`;
    }
    return this.expr(e, scope);
  }

  /** Pernyataan assignment Kotlin ke target JS (identifier atau properti). */
  assignTo(target, value, scope) {
    while (ts.isParenthesizedExpression(target)) target = target.expression;
    if (ts.isIdentifier(target)) {
      const k = scope.lookup(target.text);
      if (!k) return this.error(target, `'${target.text}' tidak dideklarasikan (variabel global tidak bisa diubah)`);
      return `${k} = ${value}`;
    }
    if (ts.isPropertyAccessExpression(target)) return `Js.set(${this.expr(target.expression, scope)}, ${kstr(target.name.text)}, ${value})`;
    if (ts.isElementAccessExpression(target)) return `Js.set(${this.expr(target.expression, scope)}, ${this.expr(target.argumentExpression, scope)}, ${value})`;
    return this.error(target, "target assignment tidak didukung");
  }

  /** Assignment sebagai ekspresi: hasilnya nilai yang diisikan. */
  assignExpr(target, value, scope) {
    const t = this.id("v");
    return `run { val ${t} = ${value}; ${this.assignTo(target, t, scope)}; ${t} }`;
  }

  expr(e, scope) {
    const S = ts.SyntaxKind;
    switch (e.kind) {
      case S.NumericLiteral:
        return knum(Number(e.text));
      case S.BigIntLiteral:
        return this.error(e, "BigInt belum didukung");
      case S.StringLiteral:
      case S.NoSubstitutionTemplateLiteral:
        return kstr(e.text);
      case S.TrueKeyword:
        return "true";
      case S.FalseKeyword:
        return "false";
      case S.NullKeyword:
        return "null";
      case S.ThisKeyword:
        return this.error(e, "`this` belum didukung di target native");
      case S.RegularExpressionLiteral: {
        const text = e.text;
        const end = text.lastIndexOf("/");
        return `Js.regex(${kstr(text.slice(1, end))}, ${kstr(text.slice(end + 1))})`;
      }
      case S.TemplateExpression: {
        const parts = [kstr(e.head.text)];
        for (const span of e.templateSpans) {
          parts.push(this.expr(span.expression, scope));
          if (span.literal.text) parts.push(kstr(span.literal.text));
        }
        return `Js.concat(${parts.join(", ")})`;
      }
      case S.Identifier:
        return this.ident(e, scope);
      case S.ParenthesizedExpression:
        return this.expr(e.expression, scope);
      case S.ArrayLiteralExpression: {
        const items = e.elements.map((el) =>
          ts.isSpreadElement(el) ? `addAll(Js.spreadList(${this.expr(el.expression, scope)}))`
          : ts.isOmittedExpression(el) ? "add(null)" : `add(${this.expr(el, scope)})`);
        return items.length ? `Js.arr { ${items.join("; ")} }` : "JsArray()";
      }
      case S.ObjectLiteralExpression:
        return this.objectLiteral(e, scope);
      case S.FunctionExpression:
      case S.ArrowFunction:
        return this.fn(e, scope, "        ");
      case S.PropertyAccessExpression:
      case S.ElementAccessExpression:
        return this.member(e, scope);
      case S.CallExpression:
        return this.call(e, scope);
      case S.NewExpression: {
        const args = this.args(e.arguments ?? [], scope);
        return `JsBuiltins.construct(${this.expr(e.expression, scope)}, ${args})`;
      }
      case S.ConditionalExpression:
        return `(if (${this.cond(e.condition, scope)}) ${this.expr(e.whenTrue, scope)} else ${this.expr(e.whenFalse, scope)})`;
      case S.PrefixUnaryExpression:
        return this.prefix(e, scope);
      case S.PostfixUnaryExpression: {
        const delta = e.operator === S.PlusPlusToken ? "+" : "-";
        const o = this.id("o");
        return `run { val ${o} = Js.toNum(${this.expr(e.operand, scope)}); ${this.assignTo(e.operand, `(${o} ${delta} 1.0)`, scope)}; ${o} }`;
      }
      case S.TypeOfExpression: {
        if (ts.isIdentifier(e.expression) && !scope.lookup(e.expression.text) && !GLOBALS.has(e.expression.text) && e.expression.text !== "undefined") {
          return kstr("undefined"); // typeof window === "undefined"
        }
        return `Js.typeOf(${this.expr(e.expression, scope)})`;
      }
      case S.VoidExpression:
        return `run { ${this.expr(e.expression, scope)}; null }`;
      case S.DeleteExpression: {
        const t = e.expression;
        if (ts.isPropertyAccessExpression(t)) return `Js.delete(${this.expr(t.expression, scope)}, ${kstr(t.name.text)})`;
        if (ts.isElementAccessExpression(t)) return `Js.delete(${this.expr(t.expression, scope)}, ${this.expr(t.argumentExpression, scope)})`;
        return "true";
      }
      case S.BinaryExpression:
        return this.binary(e, scope);
      case S.SpreadElement:
        return this.error(e, "spread di posisi ini tidak didukung");
      case S.AwaitExpression:
        return this.error(e, "async/await belum didukung di target native");
      case S.ClassExpression:
        return this.error(e, "class belum didukung di target native");
      case S.TaggedTemplateExpression:
        return this.error(e, "tagged template belum didukung");
      case S.YieldExpression:
        return this.error(e, "generator belum didukung di target native");
      default:
        return this.error(e, `ekspresi ${S[e.kind]} belum didukung di target native`);
    }
  }

  ident(e, scope) {
    const name = e.text;
    if (name === "undefined") return "null";
    const k = scope.lookup(name);
    if (k) return k;
    if (GLOBALS.has(name)) {
      this.usedGlobals.add(name);
      return `g_${name.replace(/\$/g, "_S")}`;
    }
    if (name === "arguments") return this.error(e, "`arguments` belum didukung; pakai ...args");
    return this.error(e, `'${name}' tidak tersedia di target native`);
  }

  objectLiteral(e, scope) {
    const parts = [];
    for (const p of e.properties) {
      if (ts.isPropertyAssignment(p)) {
        parts.push(`this[${this.propKey(p.name, scope)}] = ${this.expr(p.initializer, scope)}`);
      } else if (ts.isShorthandPropertyAssignment(p)) {
        parts.push(`this[${kstr(p.name.text)}] = ${this.ident(p.name, scope)}`);
      } else if (ts.isSpreadAssignment(p)) {
        parts.push(`Js.spreadInto(this, ${this.expr(p.expression, scope)})`);
      } else if (ts.isMethodDeclaration(p)) {
        parts.push(`this[${this.propKey(p.name, scope)}] = ${this.fn(p, scope, "        ")}`);
      } else {
        parts.push(this.error(p, "getter/setter belum didukung di target native"));
      }
    }
    return parts.length ? `Js.obj { ${parts.join("; ")} }` : "JsObject()";
  }

  propKey(name, scope) {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) return kstr(name.text);
    if (ts.isNumericLiteral(name)) return kstr(String(Number(name.text)));
    if (ts.isComputedPropertyName(name)) return `Js.key(${this.expr(name.expression, scope)})`;
    return this.error(name, "kunci object tidak didukung");
  }

  member(e, scope) {
    const optional = !!e.questionDotToken || ts.isOptionalChain(e);
    const getter = optional ? "Js.getOpt" : "Js.get";
    const obj = this.expr(e.expression, scope);
    if (ts.isPropertyAccessExpression(e)) return `${getter}(${obj}, ${kstr(e.name.text)})`;
    return `${getter}(${obj}, ${this.expr(e.argumentExpression, scope)})`;
  }

  args(list, scope) {
    if (!list.length) return "emptyList()";
    if (list.some((a) => ts.isSpreadElement(a))) {
      const items = list.map((a) => (ts.isSpreadElement(a) ? `addAll(Js.spreadList(${this.expr(a.expression, scope)}))` : `add(${this.expr(a, scope)})`));
      return `buildList<Any?> { ${items.join("; ")} }`;
    }
    return `listOf<Any?>(${list.map((a) => this.expr(a, scope)).join(", ")})`;
  }

  call(e, scope) {
    const args = this.args(e.arguments, scope);
    const callee = e.expression;
    const optional = ts.isOptionalChain(e);
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const obj = this.expr(callee.expression, scope);
      const name = ts.isPropertyAccessExpression(callee) ? kstr(callee.name.text) : `Js.key(${this.expr(callee.argumentExpression, scope)})`;
      const fn = optional && (callee.questionDotToken || ts.isOptionalChain(callee)) ? "Js.callMethodOpt" : "Js.callMethod";
      return `${fn}(${obj}, ${name}, ${args})`;
    }
    if (callee.kind === ts.SyntaxKind.SuperKeyword || callee.kind === ts.SyntaxKind.ImportKeyword) {
      return this.error(e, "super/import() belum didukung");
    }
    return `${optional && e.questionDotToken ? "Js.callOpt" : "Js.call"}(${this.expr(callee, scope)}, ${args})`;
  }

  prefix(e, scope) {
    const S = ts.SyntaxKind;
    const v = () => this.expr(e.operand, scope);
    switch (e.operator) {
      case S.ExclamationToken:
        return `(!${this.cond(e.operand, scope)})`;
      case S.MinusToken:
        return ts.isNumericLiteral(e.operand) ? knum(-Number(e.operand.text)) : `Js.neg(${v()})`;
      case S.PlusToken:
        return `Js.toNum(${v()})`;
      case S.TildeToken:
        return `Js.bitNot(${v()})`;
      case S.PlusPlusToken:
      case S.MinusMinusToken: {
        const delta = e.operator === S.PlusPlusToken ? "+" : "-";
        return this.assignExpr(e.operand, `(Js.toNum(${v()}) ${delta} 1.0)`, scope);
      }
      default:
        return this.error(e, "operator belum didukung");
    }
  }

  binary(e, scope) {
    const S = ts.SyntaxKind;
    const op = e.operatorToken.kind;
    const asBool = this.boolExpr(e, scope);
    if (asBool && op !== S.AmpersandAmpersandToken && op !== S.BarBarToken) return asBool;
    const l = () => this.expr(e.left, scope), r = () => this.expr(e.right, scope);
    switch (op) {
      case S.PlusToken: return `Js.add(${l()}, ${r()})`;
      case S.MinusToken: return `Js.sub(${l()}, ${r()})`;
      case S.AsteriskToken: return `Js.mul(${l()}, ${r()})`;
      case S.SlashToken: return `Js.div(${l()}, ${r()})`;
      case S.PercentToken: return `Js.mod(${l()}, ${r()})`;
      case S.AsteriskAsteriskToken: return `Js.pow(${l()}, ${r()})`;
      case S.AmpersandToken: return `Js.bitAnd(${l()}, ${r()})`;
      case S.BarToken: return `Js.bitOr(${l()}, ${r()})`;
      case S.CaretToken: return `Js.bitXor(${l()}, ${r()})`;
      case S.LessThanLessThanToken: return `Js.shl(${l()}, ${r()})`;
      case S.GreaterThanGreaterThanToken: return `Js.shr(${l()}, ${r()})`;
      case S.GreaterThanGreaterThanGreaterThanToken: return `Js.ushr(${l()}, ${r()})`;
      case S.AmpersandAmpersandToken: {
        const t = this.id("t");
        return `run { val ${t} = ${l()}; if (Js.truthy(${t})) ${r()} else ${t} }`;
      }
      case S.BarBarToken: {
        const t = this.id("t");
        return `run { val ${t} = ${l()}; if (Js.truthy(${t})) ${t} else ${r()} }`;
      }
      case S.QuestionQuestionToken:
        return `(${l()} ?: ${r()})`;
      case S.CommaToken:
        return `run { ${this.exprStatementInline(e.left, scope)}; ${r()} }`;
      case S.EqualsToken:
        if (ts.isObjectLiteralExpression(e.left) || ts.isArrayLiteralExpression(e.left)) {
          return this.error(e, "destructuring assignment belum didukung; pakai const { ... } = ...");
        }
        return this.assignExpr(e.left, r(), scope);
      case S.QuestionQuestionEqualsToken:
        return `(${l()} ?: ${this.assignExpr(e.left, r(), scope)})`;
      case S.BarBarEqualsToken: {
        const t = this.id("t");
        return `run { val ${t} = ${l()}; if (Js.truthy(${t})) ${t} else ${this.assignExpr(e.left, r(), scope)} }`;
      }
      case S.AmpersandAmpersandEqualsToken: {
        const t = this.id("t");
        return `run { val ${t} = ${l()}; if (Js.truthy(${t})) ${this.assignExpr(e.left, r(), scope)} else ${t} }`;
      }
      case S.InstanceOfKeyword:
        if (ts.isIdentifier(e.right) && e.right.text === "Array") return `(${l()} is List<*>)`;
        return this.error(e, "instanceof belum didukung (kecuali instanceof Array)");
      default: {
        const compound = COMPOUND[op];
        if (compound) return this.assignExpr(e.left, compound(l(), r()), scope);
        return this.error(e, `operator ${S[op]} belum didukung`);
      }
    }
  }
}

const K = ts.SyntaxKind;
const COMPOUND = {
  [K.PlusEqualsToken]: (a, b) => `Js.add(${a}, ${b})`,
  [K.MinusEqualsToken]: (a, b) => `Js.sub(${a}, ${b})`,
  [K.AsteriskEqualsToken]: (a, b) => `Js.mul(${a}, ${b})`,
  [K.SlashEqualsToken]: (a, b) => `Js.div(${a}, ${b})`,
  [K.PercentEqualsToken]: (a, b) => `Js.mod(${a}, ${b})`,
  [K.AsteriskAsteriskEqualsToken]: (a, b) => `Js.pow(${a}, ${b})`,
  [K.AmpersandEqualsToken]: (a, b) => `Js.bitAnd(${a}, ${b})`,
  [K.BarEqualsToken]: (a, b) => `Js.bitOr(${a}, ${b})`,
  [K.CaretEqualsToken]: (a, b) => `Js.bitXor(${a}, ${b})`,
  [K.LessThanLessThanEqualsToken]: (a, b) => `Js.shl(${a}, ${b})`,
  [K.GreaterThanGreaterThanEqualsToken]: (a, b) => `Js.shr(${a}, ${b})`,
  [K.GreaterThanGreaterThanGreaterThanEqualsToken]: (a, b) => `Js.ushr(${a}, ${b})`,
};

/**
 * Kompilasi satu komponen ke Kotlin.
 * @returns {{ code: string, objectName: string, hash: string }}
 */
export async function compileKotlin({ file, name, projectDir, plugins = [], pkg = "dev.xp.generated" }) {
  const { js, map } = await bundleForNative(file, plugins);
  const decoded = decodeMappings(map.mappings);
  map.file = path.join(path.dirname(file), ".xp-native", "out.js");
  const sf = ts.createSourceFile("bundle.js", js, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const errors = [];
  const fail = (node, reason) => {
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const where = originalPosition(map, decoded, pos.line, pos.character, projectDir) ?? `${path.basename(file)} (bundle ${pos.line + 1}:${pos.character + 1})`;
    errors.push(`${where} ${reason}`);
  };
  const em = new KotlinEmitter(sf, fail);
  const { body } = em.module();
  if (errors.length) {
    throw new NativeCompileError([...new Set(errors)].join("\n"));
  }
  const objectName = kotlinName(name);
  const hash = createHash("sha256").update(js).digest("hex").slice(0, 16);
  const globals = [...em.usedGlobals].sort().map((g) => `        val g_${g.replace(/\$/g, "_S")} = scope.global(${kstr(g)})`);
  const code = `// Dibuat oleh xp build dari ${kstr(name)}. Jangan diubah manual.
@file:Suppress("UNUSED_VARIABLE", "UNUSED_VALUE", "NAME_SHADOWING", "VARIABLE_WITH_REDUNDANT_INITIALIZER", "UNUSED_ANONYMOUS_PARAMETER", "UNREACHABLE_CODE", "ASSIGNED_BUT_NEVER_ACCESSED_VARIABLE", "UNUSED_PARAMETER", "unused", "RedundantSuppression")

package ${pkg}

import dev.xp.android.compiled.*

object ${objectName} : XPCompiledComponent {
    override val name = ${kstr(name)}
    override val hash = ${kstr(hash)}

    override fun create(scope: XPScope): JsFunction {
${globals.join("\n")}
${body.join("\n")}
        return ${em.defaultExport} as? JsFunction ?: error(${kstr(`export default ${name} bukan function`)})
    }
}
`;
  return { code, objectName, hash };
}

/** Registry semua komponen terkompilasi; SDK menemukannya lewat nama class ini. */
export function registryKotlin(entries, pkg = "dev.xp.generated") {
  const lines = entries.map((e) => `        ${kstr(e.name)} to ${e.objectName},`);
  return `// Dibuat oleh xp build. Jangan diubah manual.
package ${pkg}

import dev.xp.android.compiled.XPCompiledComponent
import dev.xp.android.compiled.XPComponentRegistry

object XPComponents : XPComponentRegistry {
    override val components: Map<String, XPCompiledComponent> = mapOf(
${lines.join("\n")}
    )
}
`;
}
