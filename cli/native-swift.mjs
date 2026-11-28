// Komponen @xp/runtime → kode Swift (iOS), padanan native-kotlin.mjs. Bundle dan sourcemap-nya
// sama; yang berbeda hanya bentuk kode yang dihasilkan. Nilai JS diwakili enum JsValue
// (XPKit/Compiled/JsValue.swift), operator JS lewat helper `Js`.
//
// Catatan bentuk kode:
//   - function JS → closure `JsFunction("nama") { (a: [JsValue]) throws -> JsValue in ... }`,
//     jadi `return` JS = `return` Swift.
//   - ekspresi yang butuh beberapa pernyataan → closure yang langsung dipanggil.
//   - `try` hanya ditulis di awal pernyataan yang memang bisa melempar error.
import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";
import { bundleForNative, decodeMappings, GLOBALS, NativeCompileError, originalPosition, Scope } from "./native-kotlin.mjs";

// Penanda closure di kode antara: isi closure tidak ikut menentukan perlu-tidaknya `try`.
const OPEN = "\u0002";
const CLOSE = "\u0003";

/** Nama struct Swift untuk komponen, mis. "promo-modal" → "XP_PromoModal". */
export function swiftName(name) {
  return "XP_" + name.split(/[^A-Za-z0-9]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join("");
}

function sstr(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c >= 0xd800 && c <= 0xdfff) out += "\\u{FFFD}"; // surrogate tunggal tidak bisa ada di String Swift
    else if (c < 0x20 || (c >= 0x7f && c < 0xa0) || c === 0x2028 || c === 0x2029) out += `\\u{${c.toString(16)}}`;
    else out += ch;
  }
  return out + '"';
}

function snum(n) {
  if (Number.isNaN(n)) return ".nan";
  if (n === Infinity) return ".infinity";
  if (n === -Infinity) return "-.infinity";
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return `${n}.0`;
  const s = String(n);
  return /[.e]/.test(s) ? s.replace("e+", "e") : `${s}.0`;
}

const num = (n) => `.num(${snum(n)})`;

// Helper yang bisa melempar error (lihat JsValue.swift / JsBuiltins.swift).
const THROWING = /\bJs\.(get|set|call|callOpt|callMethod|callMethodOpt|iter|regex|list|arraySpread|hasKey|spreadList|restOf)\(|\bJsBuiltins\.construct\(|\bscope\.global\(|F\(\)/;

/** Perlu `try`? Isi string literal dan isi closure tidak dihitung. */
function throws(code) {
  let out = "";
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === OPEN) {
      if (depth++ === 0) out += "F";
      continue;
    }
    if (ch === CLOSE) {
      depth--;
      continue;
    }
    if (depth) continue;
    if (ch === '"') {
      i++;
      while (i < code.length && code[i] !== '"') i += code[i] === "\\" ? 2 : 1;
      out += '""';
      continue;
    }
    out += ch;
  }
  return THROWING.test(out);
}

const t = (code) => (throws(code) ? `try ${code}` : code);

class SwiftEmitter {
  constructor(sf, fail) {
    this.sf = sf;
    this.fail = fail;
    this.counter = 0;
    this.usedGlobals = new Set();
    this.defaultExport = null;
    this.fnDepth = 0;
    this.loops = []; // { label, update, jsLabel, kind }
  }

  id(prefix = "t") {
    return `${prefix}${++this.counter}`;
  }

  sname(name) {
    return `j_${name.replace(/\$/g, "_S")}`;
  }

  error(node, reason) {
    this.fail(node, reason);
    return ".null";
  }

  decl(name, scope) {
    return `var ${scope.declare(name, this.sname(name))}: JsValue = .null`;
  }

  // --- deklarasi & hoisting (sama dengan versi Kotlin) ---

  bindingNames(name, out = []) {
    if (ts.isIdentifier(name)) out.push(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) if (!ts.isOmittedExpression(el)) this.bindingNames(el.name, out);
    }
    return out;
  }

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

  openBlock(statements, scope, out, ind) {
    const { lets, fns } = this.blockDecls(statements);
    for (const n of lets) {
      if (scope.names.has(n)) continue;
      out.push(`${ind}${this.decl(n, scope)}`);
    }
    for (const f of fns) {
      if (!scope.names.has(f.name.text)) out.push(`${ind}${this.decl(f.name.text, scope)}`);
    }
    for (const f of fns) out.push(`${ind}${scope.lookup(f.name.text)} = ${this.fn(f, scope, ind)}`);
  }

  module() {
    const scope = new Scope(null, true);
    const body = [];
    const ind = "        ";
    for (const n of this.collectVars(this.sf)) {
      if (!scope.names.has(n)) body.push(`${ind}${this.decl(n, scope)}`);
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
              for (const n of this.bindingNames(d.name)) out.push(`${ind}${scope.lookup(n)} = .null`);
            }
            continue;
          }
          this.assignPattern(d.name, this.expr(d.initializer, scope), scope, out, ind);
        }
        return;
      case S.FunctionDeclaration:
        return;
      case S.ExpressionStatement:
        out.push(`${ind}${this.exprStatementInline(st.expression, scope)}`);
        return;
      case S.ReturnStatement:
        if (!this.fnDepth) return void this.fail(st, "return di luar function");
        out.push(`${ind}return ${st.expression ? t(this.expr(st.expression, scope)) : ".null"}`);
        return;
      case S.IfStatement: {
        out.push(`${ind}if ${t(this.cond(st.expression, scope))} {`);
        this.nested(st.thenStatement, scope, out, ind + "    ");
        if (st.elseStatement) {
          out.push(`${ind}} else {`);
          this.nested(st.elseStatement, scope, out, ind + "    ");
        }
        out.push(`${ind}}`);
        return;
      }
      case S.Block:
        out.push(`${ind}do {`);
        this.nested(st, scope, out, ind + "    ");
        out.push(`${ind}}`);
        return;
      case S.EmptyStatement:
      case S.DebuggerStatement:
        return;
      case S.ThrowStatement:
        out.push(`${ind}throw JsError(${t(this.expr(st.expression, scope))})`);
        return;
      case S.TryStatement:
        return this.tryStatement(st, scope, out, ind);
      case S.ForStatement:
        return this.forStatement(st, scope, out, ind);
      case S.ForOfStatement:
      case S.ForInStatement:
        return this.forOf(st, scope, out, ind);
      case S.WhileStatement: {
        const label = this.id("L");
        out.push(`${ind}${label}: while ${t(this.cond(st.expression, scope))} {`);
        this.loopBody(st.statement, { label, update: null }, scope, out, ind + "    ");
        out.push(`${ind}}`);
        return;
      }
      case S.DoStatement: {
        const label = this.id("L");
        out.push(`${ind}${label}: repeat {`);
        this.loopBody(st.statement, { label, update: null }, scope, out, ind + "    ");
        out.push(`${ind}} while ${t(this.cond(st.expression, scope))}`);
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
        out.push(`${ind}${isBreak ? "break" : "continue"} ${target.label}`);
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
        out.push(`${ind}let ${tmp}: JsValue = ${t(this.expr(st.expression, scope))}`);
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

  nested(st, scope, out, ind) {
    const inner = new Scope(scope);
    this.blockInto(ts.isBlock(st) ? st.statements : [st], inner, out, ind);
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

  /** return/break/continue yang keluar dari blok finally tidak bisa ditulis di `defer` Swift. */
  jumpsOut(block) {
    let found = null;
    const visit = (n, inLoop) => {
      if (found || ts.isFunctionLike(n)) return;
      if (ts.isReturnStatement(n) || ((ts.isBreakStatement(n) || ts.isContinueStatement(n)) && (!inLoop || n.label))) {
        found = n;
        return;
      }
      ts.forEachChild(n, (c) => visit(c, inLoop || ts.isIterationStatement(n, false) || ts.isSwitchStatement(n)));
    };
    ts.forEachChild(block, (c) => visit(c, false));
    return found;
  }

  tryStatement(st, scope, out, ind) {
    const fin = st.finallyBlock;
    let inner = ind;
    if (fin) {
      const jump = this.jumpsOut(fin);
      if (jump) return void this.fail(jump, "return/break/continue di dalam finally belum didukung di target native");
      // defer di dalam blok luar: jalan setelah catch selesai, juga saat return/throw.
      out.push(`${ind}do {`);
      const body = [];
      const loops = this.loops;
      this.loops = [];
      this.nested(fin, scope, body, ind + "        ");
      this.loops = loops;
      out.push(`${ind}    defer {`);
      out.push(`${ind}        _ = try? ${OPEN}{ () throws -> Void in`);
      out.push(...body.map((l) => "    " + l));
      out.push(`${ind}        }${CLOSE}()`);
      out.push(`${ind}    }`);
      inner = ind + "    ";
    }
    if (st.catchClause) {
      out.push(`${inner}do {`);
      this.nested(st.tryBlock, scope, out, inner + "    ");
      const decl = st.catchClause.variableDeclaration;
      const sc = new Scope(scope);
      if (decl) {
        const e = this.id("e");
        out.push(`${inner}} catch let ${e} {`);
        if (ts.isIdentifier(decl.name)) out.push(`${inner}    ${this.decl(decl.name.text, sc)}`, `${inner}    ${sc.lookup(decl.name.text)} = Js.caught(${e})`);
        else {
          for (const n of this.bindingNames(decl.name)) out.push(`${inner}    ${this.decl(n, sc)}`);
          this.assignPattern(decl.name, `Js.caught(${e})`, sc, out, inner + "    ");
        }
      } else {
        out.push(`${inner}} catch {`);
      }
      this.blockInto(st.catchClause.block.statements, sc, out, inner + "    ");
      out.push(`${inner}}`);
    } else {
      this.nested(st.tryBlock, scope, out, inner);
    }
    if (fin) out.push(`${ind}}`);
  }

  forStatement(st, scope, out, ind) {
    const label = this.id("L");
    const inner = new Scope(scope);
    out.push(`${ind}do {`);
    const ind2 = ind + "    ";
    if (st.initializer) {
      if (ts.isVariableDeclarationList(st.initializer)) {
        for (const d of st.initializer.declarations) {
          for (const n of this.bindingNames(d.name)) {
            if (!inner.lookup(n) || st.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) {
              out.push(`${ind2}${this.decl(n, inner)}`);
            }
          }
          if (d.initializer) this.assignPattern(d.name, this.expr(d.initializer, inner), inner, out, ind2);
        }
      } else {
        out.push(`${ind2}${this.exprStatementInline(st.initializer, inner)}`);
      }
    }
    const update = st.incrementor ? this.exprStatementInline(st.incrementor, inner) : null;
    out.push(`${ind2}${label}: while ${st.condition ? t(this.cond(st.condition, inner)) : "true"} {`);
    this.loopBody(st.statement, { label, update }, inner, out, ind2 + "    ");
    if (update) out.push(`${ind2}    ${update}`);
    out.push(`${ind2}}`);
    out.push(`${ind}}`);
  }

  forOf(st, scope, out, ind) {
    if (ts.isForOfStatement(st) && st.awaitModifier) return void this.fail(st, "for await belum didukung");
    const label = this.id("L");
    const item = this.id("it");
    const src = ts.isForOfStatement(st) ? `Js.iter(${this.expr(st.expression, scope)})` : `Js.keys(${this.expr(st.expression, scope)})`;
    out.push(`${ind}${label}: for ${item} in ${t(src)} {`);
    const inner = new Scope(scope);
    const ind2 = ind + "    ";
    const init = st.initializer;
    if (ts.isVariableDeclarationList(init)) {
      const d = init.declarations[0];
      for (const n of this.bindingNames(d.name)) out.push(`${ind2}${this.decl(n, inner)}`);
      this.assignPattern(d.name, item, inner, out, ind2);
    } else {
      out.push(`${ind2}${this.assignStatement(init, item, inner)}`);
    }
    this.loopBody(st.statement, { label, update: null }, inner, out, ind2);
    out.push(`${ind}}`);
  }

  switchStatement(st, scope, out, ind) {
    const label = this.id("S");
    const d = this.id("d");
    const idx = this.id("i");
    out.push(`${ind}${label}: repeat {`);
    const ind2 = ind + "    ";
    out.push(`${ind2}let ${d}: JsValue = ${t(this.expr(st.expression, scope))}`);
    const clauses = st.caseBlock.clauses;
    const defaultIndex = clauses.findIndex((c) => ts.isDefaultClause(c));
    const cases = clauses.map((c, i) => [c, i]).filter(([c]) => ts.isCaseClause(c));
    if (cases.length) {
      out.push(`${ind2}var ${idx} = ${defaultIndex}`);
      cases.forEach(([c, i], n) => {
        const test = t(`Js.seq(${d}, ${this.expr(c.expression, scope)})`);
        out.push(`${ind2}${n ? "} else if" : "if"} ${test} {`, `${ind2}    ${idx} = ${i}`);
      });
      out.push(`${ind2}}`);
    } else {
      out.push(`${ind2}let ${idx} = ${defaultIndex}`);
    }
    const inner = new Scope(scope);
    this.openBlock(clauses.flatMap((c) => c.statements), inner, out, ind2);
    this.loops.push({ label, update: null, kind: "switch", jsLabel: this.takeLabel() });
    clauses.forEach((c, i) => {
      if (!c.statements.length) return;
      out.push(`${ind2}if ${idx} >= 0 && ${idx} <= ${i} {`);
      for (const s of c.statements) this.statement(s, inner, out, ind2 + "    ");
      out.push(`${ind2}}`);
    });
    this.loops.pop();
    out.push(`${ind}} while false`);
  }

  // --- pola (destructuring) ---

  assignPattern(name, value, scope, out, ind) {
    if (ts.isIdentifier(name)) {
      out.push(`${ind}${scope.lookup(name.text) ?? this.error(name, `'${name.text}' tidak dideklarasikan`)} = ${t(value)}`);
      return;
    }
    const tmp = this.id("p");
    out.push(`${ind}let ${tmp}: JsValue = ${t(value)}`);
    if (ts.isObjectBindingPattern(name)) {
      const taken = [];
      for (const el of name.elements) {
        if (el.dotDotDotToken) {
          out.push(`${ind}${scope.lookup(el.name.text)} = Js.omit(${tmp}, [${taken.join(", ")}])`);
          continue;
        }
        const keyNode = el.propertyName ?? el.name;
        const key = ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode) ? sstr(keyNode.text)
          : ts.isComputedPropertyName(keyNode) ? `Js.key(${this.expr(keyNode.expression, scope)})`
          : ts.isNumericLiteral(keyNode) ? sstr(String(Number(keyNode.text))) : this.error(keyNode, "kunci pola tidak didukung");
        taken.push(key);
        let v = `Js.get(${tmp}, ${key})`;
        if (el.initializer) v = `Js.coalesce(${v}, ${this.expr(el.initializer, scope)})`;
        this.assignPattern(el.name, v, scope, out, ind);
      }
    } else {
      name.elements.forEach((el, i) => {
        if (ts.isOmittedExpression(el)) return;
        if (el.dotDotDotToken) {
          this.assignPattern(el.name, `Js.restOf(${tmp}, ${i})`, scope, out, ind);
          return;
        }
        let v = `Js.get(${tmp}, ${num(i)})`;
        if (el.initializer) v = `Js.coalesce(${v}, ${this.expr(el.initializer, scope)})`;
        this.assignPattern(el.name, v, scope, out, ind);
      });
    }
  }

  // --- fungsi ---

  fn(node, scope, ind) {
    if (node.asteriskToken) return this.error(node, "generator belum didukung di target native");
    if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return this.error(node, "async/await belum didukung di target native");
    const args = this.id("a");
    const inner = new Scope(scope, true);
    const ind2 = ind + "    ";
    const body = [];
    const name = node.name && ts.isIdentifier(node.name) ? node.name.text : "";
    let selfRef = null;
    if (name && ts.isFunctionExpression(node)) selfRef = inner.declare(name, this.sname(name) + "_self");
    node.parameters.forEach((p, i) => {
      for (const n of this.bindingNames(p.name)) body.push(`${ind2}${this.decl(n, inner)}`);
      let v = p.dotDotDotToken ? `Js.rest(${args}, ${i})` : `Js.arg(${args}, ${i})`;
      if (p.initializer) v = `Js.coalesce(${v}, ${this.expr(p.initializer, inner)})`;
      this.assignPattern(p.name, v, inner, body, ind2);
    });
    this.fnDepth++;
    const loops = this.loops;
    this.loops = [];
    if (ts.isBlock(node.body)) {
      for (const n of this.collectVars(node.body)) {
        if (!inner.names.has(n)) body.push(`${ind2}${this.decl(n, inner)}`);
      }
      this.blockInto(node.body.statements, inner, body, ind2);
      const last = node.body.statements.at(-1);
      if (!last || !(ts.isReturnStatement(last) || ts.isThrowStatement(last))) body.push(`${ind2}return .null`);
    } else {
      body.push(`${ind2}return ${t(this.expr(node.body, inner))}`);
    }
    this.loops = loops;
    this.fnDepth--;
    const closure = `.fn(JsFunction(${sstr(name)}) ${OPEN}{ (${args}: [JsValue]) throws -> JsValue in\n${body.join("\n")}\n${ind}}${CLOSE})`;
    if (selfRef) return `${OPEN}{ () throws -> JsValue in var ${selfRef}: JsValue = .null; ${selfRef} = ${closure}; return ${selfRef} }${CLOSE}()`;
    return closure;
  }

  /** Beberapa pernyataan sebagai ekspresi: closure yang langsung dipanggil. */
  iife(statements, result) {
    return `${OPEN}{ () throws -> JsValue in ${[...statements, `return ${t(result)}`].join("; ")} }${CLOSE}()`;
  }

  // --- ekspresi ---

  cond(e, scope) {
    return this.boolExpr(e, scope) ?? `Js.truthy(${this.expr(e, scope)})`;
  }

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

  /** Ekspresi sebagai pernyataan (sudah lengkap dengan `try` kalau perlu). */
  exprStatementInline(e, scope) {
    const S = ts.SyntaxKind;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === S.EqualsToken) {
        if (ts.isObjectLiteralExpression(e.left) || ts.isArrayLiteralExpression(e.left)) {
          return this.error(e, "destructuring assignment belum didukung; pakai const { ... } = ...");
        }
        return this.assignStatement(e.left, this.expr(e.right, scope), scope);
      }
      const compound = COMPOUND[op];
      if (compound) return this.assignStatement(e.left, compound(this.expr(e.left, scope), this.expr(e.right, scope)), scope);
      if (op === S.CommaToken) return `${this.exprStatementInline(e.left, scope)}; ${this.exprStatementInline(e.right, scope)}`;
      if (op === S.AmpersandAmpersandToken) return `if ${t(this.cond(e.left, scope))} { ${this.exprStatementInline(e.right, scope)} }`;
      if (op === S.BarBarToken) return `if !(${t(this.cond(e.left, scope))}) { ${this.exprStatementInline(e.right, scope)} }`;
    }
    if ((ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) && (e.operator === S.PlusPlusToken || e.operator === S.MinusMinusToken)) {
      const delta = e.operator === S.PlusPlusToken ? "1" : "-1";
      return this.assignStatement(e.operand, `Js.inc(${this.expr(e.operand, scope)}, ${delta})`, scope);
    }
    if (ts.isConditionalExpression(e)) {
      return `if ${t(this.cond(e.condition, scope))} { ${this.exprStatementInline(e.whenTrue, scope)} } else { ${this.exprStatementInline(e.whenFalse, scope)} }`;
    }
    return `_ = ${t(this.expr(e, scope))}`;
  }

  /** Assignment ke target JS (tanpa `try`). */
  assignTo(target, value, scope) {
    while (ts.isParenthesizedExpression(target)) target = target.expression;
    if (ts.isIdentifier(target)) {
      const k = scope.lookup(target.text);
      if (!k) return this.error(target, `'${target.text}' tidak dideklarasikan (variabel global tidak bisa diubah)`);
      return `${k} = ${value}`;
    }
    if (ts.isPropertyAccessExpression(target)) return `Js.set(${this.expr(target.expression, scope)}, ${sstr(target.name.text)}, ${value})`;
    if (ts.isElementAccessExpression(target)) return `Js.set(${this.expr(target.expression, scope)}, ${this.expr(target.argumentExpression, scope)}, ${value})`;
    return this.error(target, "target assignment tidak didukung");
  }

  /** Pernyataan assignment lengkap: `x = try ...` atau `try Js.set(...)`. */
  assignStatement(target, value, scope) {
    let tt = target;
    while (ts.isParenthesizedExpression(tt)) tt = tt.expression;
    if (ts.isIdentifier(tt)) {
      const k = scope.lookup(tt.text);
      if (!k) return this.error(tt, `'${tt.text}' tidak dideklarasikan (variabel global tidak bisa diubah)`);
      return `${k} = ${t(value)}`;
    }
    return t(this.assignTo(target, value, scope));
  }

  assignExpr(target, value, scope) {
    const v = this.id("v");
    return this.iife([`let ${v}: JsValue = ${t(value)}`, this.assignStatement(target, v, scope)], v);
  }

  expr(e, scope) {
    const S = ts.SyntaxKind;
    switch (e.kind) {
      case S.NumericLiteral:
        return num(Number(e.text));
      case S.BigIntLiteral:
        return this.error(e, "BigInt belum didukung");
      case S.StringLiteral:
      case S.NoSubstitutionTemplateLiteral:
        return `.str(${sstr(e.text)})`;
      case S.TrueKeyword:
        return ".bool(true)";
      case S.FalseKeyword:
        return ".bool(false)";
      case S.NullKeyword:
        return ".null";
      case S.ThisKeyword:
        return this.error(e, "`this` belum didukung di target native");
      case S.RegularExpressionLiteral: {
        const text = e.text;
        const end = text.lastIndexOf("/");
        return `Js.regex(${sstr(text.slice(1, end))}, ${sstr(text.slice(end + 1))})`;
      }
      case S.TemplateExpression: {
        const parts = [`.str(${sstr(e.head.text)})`];
        for (const span of e.templateSpans) {
          parts.push(this.expr(span.expression, scope));
          if (span.literal.text) parts.push(`.str(${sstr(span.literal.text)})`);
        }
        return `Js.concat([${parts.join(", ")}])`;
      }
      case S.Identifier:
        return this.ident(e, scope);
      case S.ParenthesizedExpression:
        return this.expr(e.expression, scope);
      case S.ArrayLiteralExpression: {
        if (!e.elements.length) return ".arr(JsArray())";
        if (e.elements.some((el) => ts.isSpreadElement(el))) {
          const items = e.elements.map((el) =>
            ts.isSpreadElement(el) ? `.spread(${this.expr(el.expression, scope)})` : ts.isOmittedExpression(el) ? ".v(.null)" : `.v(${this.expr(el, scope)})`);
          return `Js.arraySpread([${items.join(", ")}])`;
        }
        return `Js.array([${e.elements.map((el) => (ts.isOmittedExpression(el) ? ".null" : this.expr(el, scope))).join(", ")}])`;
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
      case S.NewExpression:
        return `JsBuiltins.construct(${this.expr(e.expression, scope)}, ${this.args(e.arguments ?? [], scope)})`;
      case S.ConditionalExpression:
        return `(${this.cond(e.condition, scope)} ? ${this.expr(e.whenTrue, scope)} : ${this.expr(e.whenFalse, scope)})`;
      case S.PrefixUnaryExpression:
        return this.prefix(e, scope);
      case S.PostfixUnaryExpression: {
        const delta = e.operator === S.PlusPlusToken ? "1" : "-1";
        const o = this.id("o");
        return this.iife([`let ${o}: JsValue = ${t(this.expr(e.operand, scope))}`, this.assignStatement(e.operand, `Js.inc(${o}, ${delta})`, scope)], `.num(Js.toNum(${o}))`);
      }
      case S.TypeOfExpression: {
        if (ts.isIdentifier(e.expression) && !scope.lookup(e.expression.text) && !GLOBALS.has(e.expression.text) && e.expression.text !== "undefined") {
          return '.str("undefined")';
        }
        return `.str(Js.typeOf(${this.expr(e.expression, scope)}))`;
      }
      case S.VoidExpression:
        return this.iife([`_ = ${t(this.expr(e.expression, scope))}`], ".null");
      case S.DeleteExpression: {
        const x = e.expression;
        if (ts.isPropertyAccessExpression(x)) return `.bool(Js.delete(${this.expr(x.expression, scope)}, ${sstr(x.name.text)}))`;
        if (ts.isElementAccessExpression(x)) return `.bool(Js.delete(${this.expr(x.expression, scope)}, ${this.expr(x.argumentExpression, scope)}))`;
        return ".bool(true)";
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
    if (name === "undefined") return ".null";
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
      if (ts.isPropertyAssignment(p)) parts.push(`.kv(${this.propKey(p.name, scope)}, ${this.expr(p.initializer, scope)})`);
      else if (ts.isShorthandPropertyAssignment(p)) parts.push(`.kv(${sstr(p.name.text)}, ${this.ident(p.name, scope)})`);
      else if (ts.isSpreadAssignment(p)) parts.push(`.spread(${this.expr(p.expression, scope)})`);
      else if (ts.isMethodDeclaration(p)) parts.push(`.kv(${this.propKey(p.name, scope)}, ${this.fn(p, scope, "        ")})`);
      else parts.push(this.error(p, "getter/setter belum didukung di target native"));
    }
    return parts.length ? `Js.object([${parts.join(", ")}])` : ".obj(JsObject())";
  }

  propKey(name, scope) {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) return sstr(name.text);
    if (ts.isNumericLiteral(name)) return sstr(String(Number(name.text)));
    if (ts.isComputedPropertyName(name)) return `Js.key(${this.expr(name.expression, scope)})`;
    return this.error(name, "kunci object tidak didukung");
  }

  member(e, scope) {
    const optional = !!e.questionDotToken || ts.isOptionalChain(e);
    const getter = optional ? "Js.getOpt" : "Js.get";
    const obj = this.expr(e.expression, scope);
    if (ts.isPropertyAccessExpression(e)) return `${getter}(${obj}, ${sstr(e.name.text)})`;
    return `${getter}(${obj}, ${this.expr(e.argumentExpression, scope)})`;
  }

  args(list, scope) {
    if (!list.length) return "[]";
    if (list.some((a) => ts.isSpreadElement(a))) {
      const items = list.map((a) => (ts.isSpreadElement(a) ? `.spread(${this.expr(a.expression, scope)})` : `.v(${this.expr(a, scope)})`));
      return `Js.list([${items.join(", ")}])`;
    }
    return `[${list.map((a) => this.expr(a, scope)).join(", ")}]`;
  }

  call(e, scope) {
    const args = this.args(e.arguments, scope);
    const callee = e.expression;
    const optional = ts.isOptionalChain(e);
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const obj = this.expr(callee.expression, scope);
      const name = ts.isPropertyAccessExpression(callee) ? sstr(callee.name.text) : `Js.key(${this.expr(callee.argumentExpression, scope)})`;
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
        return `.bool(!(${this.cond(e.operand, scope)}))`;
      case S.MinusToken:
        return ts.isNumericLiteral(e.operand) ? num(-Number(e.operand.text)) : `Js.neg(${v()})`;
      case S.PlusToken:
        return `.num(Js.toNum(${v()}))`;
      case S.TildeToken:
        return `Js.bitNot(${v()})`;
      case S.PlusPlusToken:
      case S.MinusMinusToken:
        return this.assignExpr(e.operand, `Js.inc(${v()}, ${e.operator === S.PlusPlusToken ? "1" : "-1"})`, scope);
      default:
        return this.error(e, "operator belum didukung");
    }
  }

  binary(e, scope) {
    const S = ts.SyntaxKind;
    const op = e.operatorToken.kind;
    const asBool = this.boolExpr(e, scope);
    if (asBool && op !== S.AmpersandAmpersandToken && op !== S.BarBarToken) return `.bool(${asBool})`;
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
      case S.AmpersandAmpersandToken: return `Js.and(${l()}, ${r()})`;
      case S.BarBarToken: return `Js.or(${l()}, ${r()})`;
      case S.QuestionQuestionToken: return `Js.coalesce(${l()}, ${r()})`;
      case S.CommaToken: return this.iife([this.exprStatementInline(e.left, scope)], r());
      case S.EqualsToken:
        if (ts.isObjectLiteralExpression(e.left) || ts.isArrayLiteralExpression(e.left)) {
          return this.error(e, "destructuring assignment belum didukung; pakai const { ... } = ...");
        }
        return this.assignExpr(e.left, r(), scope);
      case S.QuestionQuestionEqualsToken: return `Js.coalesce(${l()}, ${this.assignExpr(e.left, r(), scope)})`;
      case S.BarBarEqualsToken: return `Js.or(${l()}, ${this.assignExpr(e.left, r(), scope)})`;
      case S.AmpersandAmpersandEqualsToken: return `Js.and(${l()}, ${this.assignExpr(e.left, r(), scope)})`;
      case S.InstanceOfKeyword:
        if (ts.isIdentifier(e.right) && e.right.text === "Array") return `.bool(Js.isArray(${l()}))`;
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
 * Variabel yang tidak pernah dibaca: deklarasinya dibuang dan assignment-nya jadi `_ = ...`,
 * supaya Xcode tidak memberi peringatan untuk kode yang dihasilkan.
 */
function tidyUnused(lines) {
  const text = lines.join("\n");
  const declared = new Set([...text.matchAll(/\bvar (j_\w+): JsValue = \.null/g)].map((m) => m[1]));
  const out = text.split("\n");
  for (const name of declared) {
    const re = new RegExp(`\\b${name}\\b`, "g");
    let reads = 0, writes = 0;
    for (const line of out) {
      for (const m of line.matchAll(re)) {
        const before = line.slice(0, m.index);
        const after = line.slice(m.index + name.length);
        if (/var $/.test(before) && after.startsWith(": JsValue = .null")) continue;
        if (/(^\s*|; |\{ )$/.test(before) && after.startsWith(" = ")) writes++;
        else reads++;
      }
    }
    if (reads > 0 && writes > 0) continue;
    for (let i = 0; i < out.length; i++) {
      if (reads === 0) {
        out[i] = out[i].replace(new RegExp(`^(\\s*)var ${name}: JsValue = \\.null$`), "$1\u0000");
        out[i] = out[i].replace(new RegExp(`(^\\s*|; |\\{ )${name} = `, "g"), "$1_ = ");
      } else {
        out[i] = out[i].replace(new RegExp(`\\bvar ${name}: JsValue = \\.null`), `let ${name}: JsValue = .null`);
      }
    }
  }
  // `_ = .null` butuh tipe eksplisit di Swift
  return out.filter((l) => !/^\s*\u0000$/.test(l)).map((l) => l.replace(/\b_ = (try )?\./g, "_ = $1JsValue."));
}

/**
 * Kompilasi satu komponen ke Swift.
 * @returns {{ code: string, typeName: string, hash: string }}
 */
export async function compileSwift({ file, name, projectDir, plugins = [] }) {
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
  const em = new SwiftEmitter(sf, fail);
  const { body } = em.module();
  if (errors.length) throw new NativeCompileError([...new Set(errors)].join("\n"));
  const typeName = swiftName(name);
  const hash = createHash("sha256").update(js).digest("hex").slice(0, 16);
  const globals = [...em.usedGlobals].sort().map((g) => `        let g_${g.replace(/\$/g, "_S")} = try scope.global(${sstr(g)})`);
  const ret = `        guard case .fn(let component) = ${em.defaultExport} else { throw JsError(${sstr(`export default ${name} bukan function`)}) }`;
  const lines = tidyUnused([...globals, ...body, ret]).join("\n").replace(/[\u0002\u0003]/g, "");
  const code = `// Dibuat oleh xp build dari ${sstr(name)}. Jangan diubah manual.
import XPKit

public struct ${typeName}: XPCompiledComponent {
    public let name = ${sstr(name)}
    public let hash = ${sstr(hash)}

    public init() {}

    public func create(_ scope: XPScope) throws -> JsFunction {
${lines}
        return component
    }
}
`;
  return { code, typeName, hash };
}

/** Registry semua komponen terkompilasi; SDK menemukannya lewat nama class Objective-C ini. */
export function registrySwift(entries) {
  const lines = entries.map((e) => `        ${sstr(e.name)}: ${e.typeName}(),`);
  return `// Dibuat oleh xp build. Jangan diubah manual.
import Foundation
import XPKit

@objc(XPGeneratedComponents)
public final class XPGeneratedComponents: NSObject, XPComponentRegistry {
    public static let components: [String: XPCompiledComponent] = ${lines.length ? `[\n${lines.join("\n")}\n    ]` : "[:]"}
}
`;
}
