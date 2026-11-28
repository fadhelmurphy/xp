// Komponen @xp/runtime → Swift bertipe (mode typed untuk iOS).
//
// Analisis tipenya sama dengan versi Kotlin (native-typed.mjs: tipe TypeScript, modul, nama); yang
// berbeda hanya kode yang ditulis. Hasilnya class Swift biasa yang memakai runtime XPKit/Typed
// (XPTyped.swift): state `Double`, `String`, class, closure. Tanpa JavaScriptCore, tanpa XPTree.
//
// Fitur yang di Swift tidak bisa dibuat persis sama dengan JS (throw tanpa `throws`, urutan kunci
// Object.keys, identitas array/fungsi) ditolak, lalu xp build memakai jalur dinamis untuk komponen itu.
import ts from "typescript";
import { base, COMPOUND, Compiler, compileModules, decodeEntities, HOOKS, isOpt, jsxText, opt, PRIMITIVES, same, T, TIMERS } from "./native-typed.mjs";

const SWIFT_KEYWORDS = new Set(
  "associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default defer do else fallthrough for guard if in repeat return throw switch where while Any as await false is nil self Self super throws true try some any Type Protocol".split(
    " ",
  ),
);

function swiftString(s) {
  return `"${swiftStringBody(s)}"`;
}

function swiftStringBody(s) {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || (c >= 0x7f && c < 0xa0)) out += `\\u{${c.toString(16)}}`;
    else out += ch;
  }
  return out;
}

function swiftNum(n) {
  if (Number.isNaN(n)) return "Double.nan";
  if (n === Infinity) return "Double.infinity";
  if (n === -Infinity) return "-Double.infinity";
  if (Object.is(n, -0)) return "-0.0";
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return `${n}.0`;
  const s = String(n);
  return /[.e]/.test(s) ? s.replace("e+", "e") : `${s}.0`;
}

const swift = {
  name: "swift",
  str: swiftString,
  num: swiftNum,
  nil: "nil",
  bang: "!",
  ident(n) {
    if (/^_+$/.test(n)) return "unused";
    return SWIFT_KEYWORDS.has(n) ? `${n}_` : n.replace(/\$/g, "_S");
  },
  type(t) {
    switch (t.k) {
      case "num": return "Double";
      case "str": return "String";
      case "bool": return "Bool";
      case "void": return "Void";
      case "any": return "Any?";
      case "el": return "Any?";
      case "env": return "XPEnv";
      case "regex": return "JsValue";
      case "opt": {
        const inner = this.type(t.t);
        if (inner.endsWith("?")) return inner;
        return t.t.k === "fn" ? `(${inner})?` : `${inner}?`;
      }
      case "list": return `[${this.type(t.t)}]`;
      case "map": return `[String: ${this.type(t.t)}]`;
      case "obj": return t.cls.name;
      case "fn": return `(${t.params.map((p) => this.type(p)).join(", ")}) -> ${this.type(t.ret)}`;
      case "setter": return `XPSetter<${this.type(t.t)}>`;
      case "ref": return `XPRef<${this.type(t.t)}>`;
      default: throw new Error(`tipe ${t.k}`);
    }
  },
  /** Tipe parameter fungsi: closure yang disimpan/ditangkap harus @escaping. */
  param(t) {
    return t.k === "fn" ? `@escaping ${this.type(t)}` : this.type(t);
  },
};

/** Tipe yang aman dipakai dari banyak thread (Sendable): tidak butuh nonisolated(unsafe). */
function sendable(t) {
  if (t.k === "num" || t.k === "str" || t.k === "bool") return true;
  if (t.k === "opt" || t.k === "list") return sendable(t.t);
  return false;
}

const isNil = (code) => code === "nil";

class SwiftCompiler extends Compiler {
  // --- deklarasi level modul ---

  module(sf, out) {
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) continue;
      if (ts.isExportDeclaration(st)) {
        if (st.moduleSpecifier) this.fail(st, "re-export belum didukung di mode typed");
        continue;
      }
      if (ts.isFunctionDeclaration(st)) {
        out.push(...this.functionDecl(st, "    "), "");
        continue;
      }
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) {
            this.fail(d, "destructuring di level modul belum didukung");
            continue;
          }
          const init = d.initializer;
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            out.push(...this.functionDecl(init, "    ", d.name), "");
            continue;
          }
          const name = this.nameFor(this.symbolOf(d.name), d.name.text);
          const type = this.typeOfNode(d.name);
          const mutable = !(st.declarationList.flags & ts.NodeFlags.Const);
          const value = init ? this.expr(init, type, { scope: "module" }).code : "nil";
          const attr = mutable || !sendable(type) ? "nonisolated(unsafe) " : "";
          out.push(`    ${attr}static ${mutable ? "var" : "let"} ${name}: ${this.t.type(mutable && !init ? opt(type) : type)} = ${value}`);
        }
        continue;
      }
      if (ts.isExportAssignment(st)) continue;
      if (ts.isEnumDeclaration(st)) {
        this.enumDecl(st, out);
        continue;
      }
      if (ts.isEmptyStatement(st)) continue;
      this.fail(st, `pernyataan level modul ${ts.SyntaxKind[st.kind]} belum didukung di mode typed`);
    }
  }

  enumDecl(st, out) {
    let next = 0;
    for (const m of st.members) {
      const name = this.nameFor(this.checker.getSymbolAtLocation(m.name), `${st.name.text}_${m.name.text}`);
      let value = next;
      if (m.initializer) {
        value = this.checker.getConstantValue(m);
        if (value === undefined) {
          this.fail(m, "nilai enum harus konstanta");
          continue;
        }
      }
      if (typeof value === "number") next = value + 1;
      out.push(`    static let ${name}: ${typeof value === "number" ? "Double" : "String"} = ${typeof value === "number" ? swiftNum(value) : swiftString(value)}`);
    }
  }

  functionDecl(fn, ind, nameNode = fn.name) {
    if (fn.asteriskToken) return [this.fail(fn, "generator belum didukung").code];
    if (fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return [this.fail(fn, "async belum didukung di mode typed").code];
    const jsName = nameNode?.text ?? "default";
    const sym = nameNode ? this.symbolOf(nameNode) : fn.symbol;
    const name = this.nameFor(sym ?? fn, jsName);
    const isComp = this.isComponentFn(jsName, fn);
    const isHook = /^use[A-Z]/.test(jsName);
    const ret = isComp ? T.el : this.mapType(this.checker.getSignatureFromDeclaration(fn).getReturnType(), fn);
    const ctx = { scope: "fn", hooks: isComp || isHook, ret, fn };
    const body = [];
    const params = [];
    if (isComp) {
      if (fn.parameters.length > 1) this.fail(fn, "komponen hanya punya satu parameter props");
      const p = fn.parameters[0];
      if (p) {
        const pt = this.typeOfNode(p.name);
        if (pt.k !== "obj") this.fail(p, "props komponen harus berupa object dengan tipe yang jelas");
        params.push(`_ p: ${this.t.type(pt)}`);
        this.bindParam(p, "p", pt, body, ind + "    ", ctx);
      } else {
        params.push("_ p: Void");
      }
      params.push("_ h: XPHooks");
      this.components.set(sym ?? fn, { name, cls: p ? this.typeOfNode(p.name).cls : null });
    } else {
      if (isHook) params.push("_ h: XPHooks");
      const fp = this.fnParams(fn, ind + "    ", ctx, false);
      params.push(...fp.params);
      body.push(...fp.pre);
    }
    this.functionBody(fn, body, ind + "    ", ctx);
    const attr = ret.k === "void" ? "" : `${ind}@discardableResult\n`;
    return [`${attr}${ind}static func ${name}(${params.join(", ")}) -> ${this.t.type(ret)} {`, ...body, `${ind}}`];
  }

  bindParam(p, raw, pt, out, ind, ctx) {
    if (ts.isIdentifier(p.name)) {
      const n = this.nameFor(this.symbolOf(p.name), p.name.text);
      const value = p.initializer ? `(${raw} ?? ${this.expr(p.initializer, base(pt), ctx).code})` : raw;
      out.push(`${ind}let ${n}: ${this.t.type(p.initializer ? base(pt) : pt)} = ${value}`);
      return;
    }
    this.pattern(p.name, raw, pt, out, ind, ctx, false);
  }

  pattern(name, value, vt, out, ind, ctx, mutable) {
    const kw = mutable ? "var" : "let";
    if (ts.isIdentifier(name)) {
      out.push(`${ind}${kw} ${this.nameFor(this.symbolOf(name), name.text)}: ${this.t.type(this.typeOfNode(name))} = ${value}`);
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      const b = base(vt);
      if (b.k !== "obj" && b.k !== "env") return void this.fail(name, "destructuring object hanya untuk object bertipe");
      for (const el of name.elements) {
        if (el.dotDotDotToken) {
          this.fail(el, "rest di destructuring belum didukung di mode typed");
          continue;
        }
        const key = (el.propertyName ?? el.name).text;
        const field = b.k === "env" ? { id: key, t: key === "dark" ? T.bool : T.num } : b.cls.fields.find((f) => f.name === key);
        if (!field) {
          this.fail(el, `properti '${key}' tidak ada`);
          continue;
        }
        let v = `${value}${isOpt(vt) ? "?." : "."}${field.id}`;
        let ft = isOpt(vt) ? opt(field.t) : field.t;
        if (el.initializer) {
          v = `(${v} ?? ${this.expr(el.initializer, base(ft), ctx).code})`;
          ft = base(ft);
        }
        if (ts.isIdentifier(el.name)) out.push(`${ind}${kw} ${this.nameFor(this.symbolOf(el.name), el.name.text)}: ${this.t.type(ft)} = ${v}`);
        else {
          const t2 = this.tmp("p");
          out.push(`${ind}let ${t2}: ${this.t.type(ft)} = ${v}`);
          this.pattern(el.name, t2, ft, out, ind, ctx, mutable);
        }
      }
      return;
    }
    const b = base(vt);
    if (b.k !== "list" || isOpt(vt)) return void this.fail(name, "destructuring array hanya untuk array bertipe");
    name.elements.forEach((el, i) => {
      if (ts.isOmittedExpression(el)) return;
      if (el.dotDotDotToken) {
        out.push(`${ind}${kw} ${this.nameFor(this.symbolOf(el.name), el.name.text)}: ${this.t.type(b)} = Array(${value}.dropFirst(${i}))`);
        return;
      }
      let v = `${value}[${i}]`;
      let t = b.t;
      if (el.initializer) v = `(XPStd.at(${value}, ${i}.0) ?? ${this.expr(el.initializer, b.t, ctx).code})`;
      if (ts.isIdentifier(el.name)) out.push(`${ind}${kw} ${this.nameFor(this.symbolOf(el.name), el.name.text)}: ${this.t.type(t)} = ${v}`);
      else {
        const t2 = this.tmp("p");
        out.push(`${ind}let ${t2}: ${this.t.type(t)} = ${v}`);
        this.pattern(el.name, t2, t, out, ind, ctx, mutable);
      }
    });
  }

  functionBody(fn, out, ind, ctx) {
    if (!ts.isBlock(fn.body)) {
      if (ctx.ret.k === "void") {
        out.push(`${ind}${this.exprStatement(fn.body, ctx)}`);
        return;
      }
      out.push(`${ind}return ${this.coerce(this.expr(fn.body, ctx.ret, ctx), ctx.ret, fn.body)}`);
      return;
    }
    this.block(fn.body.statements, out, ind, ctx);
    const last = fn.body.statements.at(-1);
    if (ctx.ret.k !== "void" && !(last && ts.isReturnStatement(last))) {
      out.push(`${ind}return ${ctx.ret.k === "el" || isOpt(ctx.ret) ? "nil" : this.fail(fn, "fungsi harus selalu mengembalikan nilai").code}`);
    }
  }

  // --- pernyataan ---

  statement(st, out, ind, ctx) {
    const K = ts.SyntaxKind;
    switch (st.kind) {
      case K.VariableStatement: {
        const mutable = !(st.declarationList.flags & ts.NodeFlags.Const);
        for (const d of st.declarationList.declarations) this.varDecl(d, mutable, out, ind, ctx);
        return;
      }
      case K.FunctionDeclaration: {
        const inner = { ...ctx, ret: this.mapType(this.checker.getSignatureFromDeclaration(st).getReturnType(), st) };
        out.push(...this.localFunction(st, st.name, ind, inner));
        return;
      }
      case K.ExpressionStatement:
        out.push(`${ind}${this.exprStatement(st.expression, ctx)}`);
        return;
      case K.ReturnStatement: {
        if (!st.expression) {
          out.push(`${ind}return${ctx.ret.k === "void" ? "" : " nil"}`);
          return;
        }
        if (ctx.ret.k === "void") {
          out.push(`${ind}${this.exprStatement(st.expression, ctx)}`, `${ind}return`);
          return;
        }
        out.push(`${ind}return ${this.coerce(this.expr(st.expression, ctx.ret, ctx), ctx.ret, st.expression)}`);
        return;
      }
      case K.IfStatement: {
        out.push(`${ind}if ${this.cond(st.expression, ctx)} {`);
        this.nested(st.thenStatement, out, ind + "    ", ctx);
        if (st.elseStatement) {
          if (ts.isIfStatement(st.elseStatement)) {
            const inner = [];
            this.statement(st.elseStatement, inner, ind, ctx);
            out.push(`${ind}} else ${inner[0].trimStart()}`, ...inner.slice(1));
            return;
          }
          out.push(`${ind}} else {`);
          this.nested(st.elseStatement, out, ind + "    ", ctx);
        }
        out.push(`${ind}}`);
        return;
      }
      case K.Block:
        out.push(`${ind}do {`);
        this.block(st.statements, out, ind + "    ", ctx);
        out.push(`${ind}}`);
        return;
      case K.ForOfStatement: {
        const src = this.expr(st.expression, null, ctx);
        if (src.type.k !== "list") return void this.fail(st.expression, "for...of hanya untuk array bertipe");
        const d = st.initializer.declarations?.[0];
        if (!d) return void this.fail(st, "for...of butuh deklarasi variabel");
        const it = ts.isIdentifier(d.name) ? this.nameFor(this.symbolOf(d.name), d.name.text) : this.tmp("it");
        out.push(`${ind}for ${it} in ${src.code} {`);
        if (!ts.isIdentifier(d.name)) this.pattern(d.name, it, src.type.t, out, ind + "    ", ctx, false);
        this.loopBody(st.statement, out, ind + "    ", ctx);
        out.push(`${ind}}`);
        return;
      }
      case K.ForStatement: {
        out.push(`${ind}do {`);
        const ind2 = ind + "    ";
        if (st.initializer) {
          if (ts.isVariableDeclarationList(st.initializer)) for (const d of st.initializer.declarations) this.varDecl(d, true, out, ind2, ctx);
          else out.push(`${ind2}${this.exprStatement(st.initializer, ctx)}`);
        }
        const update = st.incrementor ? this.exprStatement(st.incrementor, ctx) : null;
        out.push(`${ind2}while ${st.condition ? this.cond(st.condition, ctx) : "true"} {`);
        this.loopBody(st.statement, out, ind2 + "    ", { ...ctx, update });
        if (update) out.push(`${ind2}    ${update}`);
        out.push(`${ind2}}`, `${ind}}`);
        return;
      }
      case K.WhileStatement:
        out.push(`${ind}while ${this.cond(st.expression, ctx)} {`);
        this.loopBody(st.statement, out, ind + "    ", { ...ctx, update: null });
        out.push(`${ind}}`);
        return;
      case K.DoStatement:
        out.push(`${ind}repeat {`);
        this.loopBody(st.statement, out, ind + "    ", { ...ctx, update: null });
        out.push(`${ind}} while ${this.cond(st.expression, ctx)}`);
        return;
      case K.BreakStatement:
        if (st.label) return void this.fail(st, "label belum didukung di mode typed");
        out.push(`${ind}break`);
        return;
      case K.ContinueStatement:
        if (st.label) return void this.fail(st, "label belum didukung di mode typed");
        if (ctx.update) out.push(`${ind}${ctx.update}`);
        out.push(`${ind}continue`);
        return;
      case K.SwitchStatement:
        return this.switchStatement(st, out, ind, ctx);
      case K.EmptyStatement:
        return;
      case K.ThrowStatement:
        return void this.fail(st, "throw belum didukung di mode typed Swift");
      default:
        this.fail(st, `pernyataan ${K[st.kind]} belum didukung di mode typed`);
    }
  }

  switchStatement(st, out, ind, ctx) {
    const d = this.expr(st.expression, null, ctx);
    const tmp = this.tmp("s");
    out.push(`${ind}let ${tmp}: ${this.t.type(d.type)} = ${d.code}`);
    let pending = [];
    let first = true;
    let open = false;
    for (const c of st.caseBlock.clauses) {
      if (ts.isCaseClause(c)) pending.push(this.equals({ code: tmp, type: d.type }, this.expr(c.expression, d.type, ctx), c));
      else pending.push(null);
      if (!c.statements.length) continue;
      const stmts = [...c.statements];
      const last = stmts.at(-1);
      if (last && ts.isBreakStatement(last)) stmts.pop();
      else if (!(last && (ts.isReturnStatement(last) || ts.isThrowStatement(last)))) this.fail(c, "case tanpa break (fallthrough) belum didukung di mode typed");
      const head = pending.includes(null) ? null : pending.join(" || ");
      if (head === null) out.push(first ? `${ind}do {` : `${ind}} else {`);
      else out.push(first ? `${ind}if ${head} {` : `${ind}} else if ${head} {`);
      this.block(stmts, out, ind + "    ", ctx);
      first = false;
      open = true;
      pending = [];
      if (head === null) break;
    }
    if (open) out.push(`${ind}}`);
  }

  varDecl(d, mutable, out, ind, ctx) {
    const init = d.initializer;
    if (init && ts.isCallExpression(init) && this.runtimeName(init.expression) === "useState") {
      if (!ts.isArrayBindingPattern(d.name)) return void this.fail(d, "hasil useState harus di-destructure: const [x, setX] = useState(...)");
      const stateType = this.mapType(this.checker.getTypeAtLocation(d.name.elements[0]), d);
      const arg = init.arguments[0];
      let initCode = arg ? this.expr(arg, stateType, ctx) : { code: "nil", type: T.void };
      if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) initCode = { code: this.call0(arg, stateType, ctx), type: stateType };
      const names = d.name.elements.slice(0, 2).map((e) => (e && !ts.isOmittedExpression(e) ? this.nameFor(this.symbolOf(e.name), e.name.text) : "_"));
      while (names.length < 2) names.push("_");
      this.requireHooks(init, ctx);
      out.push(`${ind}let (${names[0]}, ${names[1]}) = h.state { () -> ${this.t.type(stateType)} in ${this.coerce(initCode, stateType, arg ?? init)} }`);
      return;
    }
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && ts.isIdentifier(d.name) && !mutable) {
      const inner = { ...ctx, ret: this.mapType(this.checker.getSignatureFromDeclaration(init).getReturnType(), init) };
      out.push(...this.localFunction(init, d.name, ind, inner));
      return;
    }
    if (!ts.isIdentifier(d.name)) {
      if (!init) return void this.fail(d, "destructuring butuh nilai");
      const e = this.expr(init, null, ctx);
      const t = this.tmp("p");
      out.push(`${ind}let ${t}: ${this.t.type(e.type)} = ${e.code}`);
      this.pattern(d.name, t, e.type, out, ind, ctx, mutable);
      return;
    }
    const name = this.nameFor(this.symbolOf(d.name), d.name.text);
    let type = this.typeOfNode(d.name);
    if (!init) {
      out.push(`${ind}var ${name}: ${this.t.type(opt(type))} = nil`);
      return;
    }
    const e = this.expr(init, type, ctx);
    if (e.type.k === "setter" || e.type.k === "ref") type = e.type;
    out.push(`${ind}${mutable ? "var" : "let"} ${name}: ${this.t.type(type)} = ${this.coerce(e, type, init)}`);
  }

  localFunction(fn, nameNode, ind, ctx) {
    const name = this.nameFor(this.symbolOf(nameNode), nameNode.text);
    const { params, pre } = this.fnParams(fn, ind + "    ", ctx, false);
    const body = [...pre];
    this.functionBody(fn, body, ind + "    ", { ...ctx, inLoop: false, update: null });
    const attr = ctx.ret.k === "void" ? [] : [`${ind}@discardableResult`];
    return [...attr, `${ind}func ${name}(${params.join(", ")}) -> ${this.t.type(ctx.ret)} {`, ...body, `${ind}}`];
  }

  /** Parameter fungsi (`_ x: T`) atau closure (`x: T`). */
  fnParams(fn, ind, ctx, closure = true) {
    const params = [];
    const pre = [];
    const label = closure ? "" : "_ ";
    fn.parameters.forEach((p, i) => {
      if (p.dotDotDotToken) this.fail(p, "parameter rest belum didukung di mode typed");
      const pt = this.typeOfNode(p.name);
      if (ts.isIdentifier(p.name) && !p.initializer) {
        params.push(`${label}${this.nameFor(this.symbolOf(p.name), p.name.text)}: ${this.t.param(p.questionToken ? opt(pt) : pt)}`);
      } else {
        const raw = `a${i}_${this.counter++}`;
        params.push(`${label}${raw}: ${this.t.param(p.initializer ? opt(pt) : pt)}`);
        this.bindParam(p, raw, p.initializer ? opt(pt) : pt, pre, ind, ctx);
      }
    });
    return { params, pre };
  }

  // --- ekspresi ---

  coerce(e, want, node) {
    if (!want) return e.code;
    if (e.type.k === "setter" && base(want).k === "fn") {
      const v = this.tmp("v");
      return `{ (${v}: ${this.t.type(e.type.t)}) -> Void in ${e.code}(${v}) }`;
    }
    return e.code;
  }

  exprStatement(e, ctx) {
    const K = ts.SyntaxKind;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === K.EqualsToken) return this.assign(e.left, this.coerce(this.expr(e.right, this.typeOfNode(e.left), ctx), this.typeOfNode(e.left), e.right), ctx);
      const compound = COMPOUND[op];
      if (compound) return this.assign(e.left, this.binary(e, compound, ctx).code, ctx);
      if (op === K.AmpersandAmpersandToken) return `if ${this.cond(e.left, ctx)} { ${this.exprStatement(e.right, ctx)} }`;
      if (op === K.BarBarToken) return `if !${this.wrapCond(this.cond(e.left, ctx))} { ${this.exprStatement(e.right, ctx)} }`;
      if (op === K.CommaToken) return `${this.exprStatement(e.left, ctx)}; ${this.exprStatement(e.right, ctx)}`;
    }
    if ((ts.isPrefixUnaryExpression(e) || ts.isPostfixUnaryExpression(e)) && (e.operator === K.PlusPlusToken || e.operator === K.MinusMinusToken)) {
      const t = this.expr(e.operand, null, ctx);
      if (t.type.k !== "num") return this.fail(e, "++/-- hanya untuk number").code;
      return this.assign(e.operand, `${t.code} ${e.operator === K.PlusPlusToken ? "+" : "-"} 1.0`, ctx);
    }
    if (ts.isConditionalExpression(e)) {
      return `if ${this.cond(e.condition, ctx)} { ${this.exprStatement(e.whenTrue, ctx)} } else { ${this.exprStatement(e.whenFalse, ctx)} }`;
    }
    const v = this.expr(e, null, ctx);
    if (v.type.k === "void" || /^h\.(setTimeout|setInterval)\(/.test(v.code)) return v.code;
    return `_ = ${v.code}`;
  }

  assign(target, value, ctx) {
    while (ts.isParenthesizedExpression(target)) target = target.expression;
    if (ts.isIdentifier(target)) {
      const sym = this.symbolOf(target);
      if (!this.names.has(sym)) return this.fail(target, `'${target.text}' tidak bisa diubah`).code;
      return `${this.names.get(sym)} = ${value}`;
    }
    if (ts.isPropertyAccessExpression(target)) {
      const obj = this.expr(target.expression, null, ctx);
      const b = base(obj.type);
      if (b.k === "ref" && target.name.text === "current") return `${obj.code}.current = ${value}`;
      if (b.k === "obj") {
        const f = b.cls.fields.find((x) => x.name === target.name.text);
        if (!f) return this.fail(target, "properti tidak ada").code;
        return `${obj.code}${isOpt(obj.type) ? "!" : ""}.${f.id} = ${value}`;
      }
    }
    return this.fail(target, "target assignment ini belum didukung di mode typed").code;
  }

  truthy(v) {
    const t = v.type;
    if (t.k === "bool") return v.code;
    if (t.k === "opt" && t.t.k === "bool") return `(${v.code} == true)`;
    if (t.k === "num" || t.k === "str" || (t.k === "opt" && (t.t.k === "num" || t.t.k === "str")) || t.k === "any" || t.k === "el") return `XPStd.truthy(${v.code})`;
    if (t.k === "opt") return `(${v.code} != nil)`;
    return "true";
  }

  expr(e, want, ctx) {
    const K = ts.SyntaxKind;
    switch (e.kind) {
      case K.NumericLiteral:
        return { code: swiftNum(Number(e.text)), type: T.num };
      case K.StringLiteral:
      case K.NoSubstitutionTemplateLiteral:
        return { code: swiftString(e.text), type: T.str };
      case K.TrueKeyword:
        return { code: "true", type: T.bool };
      case K.FalseKeyword:
        return { code: "false", type: T.bool };
      case K.NullKeyword:
        return { code: "nil", type: T.void };
      case K.ParenthesizedExpression: {
        const inner = this.expr(e.expression, want, ctx);
        return { code: `(${inner.code})`, type: inner.type };
      }
      case K.NonNullExpression: {
        const inner = this.expr(e.expression, want, ctx);
        if (isOpt(inner.type) && inner.type.k !== "any") return { code: `${inner.code}!`, type: base(inner.type) };
        return inner;
      }
      case K.AsExpression:
      case K.SatisfiesExpression:
      case K.TypeAssertionExpression: {
        const inner = this.expr(e.expression, want, ctx);
        if (e.kind !== K.SatisfiesExpression) {
          const t = this.typeOfNode(e);
          if (!same(t, inner.type) && inner.type.k !== "void") {
            if (e.type.kind === K.TypeReference && e.type.typeName.getText() === "const") return inner;
            return this.fail(e, "`as` yang mengubah tipe belum didukung di mode typed");
          }
        }
        return inner;
      }
      case K.Identifier:
        return this.ident(e, ctx);
      case K.TemplateExpression: {
        const parts = [{ code: swiftString(e.head.text), type: T.str }];
        for (const span of e.templateSpans) {
          parts.push({ code: this.toStr(this.expr(span.expression, null, ctx)), type: T.str });
          if (span.literal.text) parts.push({ code: swiftString(span.literal.text), type: T.str });
        }
        return { code: this.interpolate(parts.map((p) => p.code)), type: T.str };
      }
      case K.ArrayLiteralExpression:
        return this.arrayLiteral(e, want, ctx);
      case K.ObjectLiteralExpression:
        return this.objectLiteral(e, want, ctx);
      case K.ArrowFunction:
      case K.FunctionExpression:
        return this.lambda(e, ctx, null, want);
      case K.PropertyAccessExpression:
        return this.property(e, ctx);
      case K.ElementAccessExpression:
        return this.element(e, ctx);
      case K.CallExpression:
        return this.call(e, want, ctx);
      case K.ConditionalExpression: {
        const t = want && base(want).k !== "any" && want.k !== "bool" ? want : this.typeOfNode(e);
        const a = this.coerce(this.expr(e.whenTrue, t, ctx), t, e);
        const b = this.coerce(this.expr(e.whenFalse, t, ctx), t, e);
        const cast = (c) => (isOpt(t) || t.k === "el" || t.k === "void" ? `(${c} as ${this.t.type(t.k === "void" ? T.any : t)})` : c);
        return { code: `(${this.cond(e.condition, ctx)} ? ${cast(a)} : ${cast(b)})`, type: t };
      }
      case K.PrefixUnaryExpression:
        return this.prefix(e, ctx);
      case K.PostfixUnaryExpression:
        return this.fail(e, "x++ sebagai nilai belum didukung; pakai sebagai pernyataan");
      case K.BinaryExpression:
        return this.binaryExpr(e, want, ctx);
      case K.JsxElement:
      case K.JsxSelfClosingElement:
      case K.JsxFragment:
        return this.jsx(e, ctx);
      case K.RegularExpressionLiteral: {
        const text = e.text;
        const end = text.lastIndexOf("/");
        return { code: `XPStd.regex(${swiftString(text.slice(1, end))}, ${swiftString(text.slice(end + 1))})`, type: T.regex };
      }
      case K.TypeOfExpression:
        return this.fail(e, "typeof belum didukung di mode typed");
      default:
        return this.fail(e, `ekspresi ${K[e.kind]} belum didukung di mode typed`);
    }
  }

  /** Gabungan string → satu literal dengan interpolasi (lebih cepat di type-checker Swift daripada `+`). */
  interpolate(codes) {
    let out = "";
    for (const c of codes) {
      const lit = /^"((?:[^"\\]|\\.)*)"$/.exec(c);
      out += lit ? lit[1] : `\\(${c})`;
    }
    return `"${out}"`;
  }

  ident(e, ctx) {
    if (e.text === "undefined") return { code: "nil", type: T.void };
    if (e.text === "NaN") return { code: "Double.nan", type: T.num };
    if (e.text === "Infinity") return { code: "Double.infinity", type: T.num };
    return super.ident(e, ctx);
  }

  arrayLiteral(e, want, ctx) {
    let t = this.typeOfNode(e);
    if (want && base(want).k === "list") t = base(want);
    if (t.k !== "list") return this.fail(e, "array harus punya tipe elemen yang jelas");
    const ty = this.t.type(t);
    if (!e.elements.length) return { code: `([] as ${ty})`, type: t };
    if (e.elements.some((x) => ts.isSpreadElement(x))) {
      const parts = e.elements.map((x) => (ts.isSpreadElement(x) ? this.expr(x.expression, t, ctx).code : `[${this.coerce(this.expr(x, t.t, ctx), t.t, x)}]`));
      return { code: `((${parts.join(" + ")}) as ${ty})`, type: t };
    }
    return { code: `([${e.elements.map((x) => this.coerce(this.expr(x, t.t, ctx), t.t, x)).join(", ")}] as ${ty})`, type: t };
  }

  objectLiteral(e, want, ctx) {
    let t = want && base(want).k !== "any" ? base(want) : this.mapType(this.checker.getContextualType(e) ?? this.checker.getTypeAtLocation(e), e);
    if (t.k === "opt") t = t.t;
    if (t.k !== "map" && t.k !== "obj") t = this.typeOfNode(e);
    if (t.k === "map") return this.mapLiteral(e, t, ctx);
    if (t.k !== "obj") return this.fail(e, "object literal harus punya tipe yang jelas");
    const values = new Map();
    for (const p of e.properties) {
      if (ts.isSpreadAssignment(p)) return this.fail(p, "spread object ke type alias belum didukung di mode typed");
      const key = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null);
      if (!key) return this.fail(p, "kunci object harus nama tetap");
      const field = t.cls.fields.find((f) => f.name === key);
      if (!field) return this.fail(p, `properti '${key}' tidak ada di tipe ${t.cls.name}`);
      if (ts.isPropertyAssignment(p)) values.set(key, this.coerce(this.expr(p.initializer, field.t, ctx), field.t, p.initializer));
      else if (ts.isShorthandPropertyAssignment(p)) values.set(key, this.coerce(this.ident(p.name, ctx), field.t, p));
      else if (ts.isMethodDeclaration(p)) values.set(key, this.lambda(p, ctx, null, field.t).code);
      else return this.fail(p, "properti object ini belum didukung");
    }
    const args = t.cls.fields.map((f) => (values.has(f.name) ? values.get(f.name) : isOpt(f.t) ? "nil" : this.fail(e, `properti '${f.name}' wajib diisi`).code));
    return { code: `${t.cls.name}(${args.join(", ")})`, type: t };
  }

  /** Style dan object untuk renderer: dictionary. Yang isinya konstanta diangkat ke static let. */
  mapLiteral(e, t, ctx) {
    const parts = [];
    let pending = new Map();
    let constant = true;
    const flush = () => {
      if (pending.size) parts.push(`xpMap([${[...pending.values()].join(", ")}])`);
      pending = new Map();
    };
    for (const p of e.properties) {
      if (ts.isSpreadAssignment(p)) {
        flush();
        const v = this.expr(p.expression, t, ctx);
        if (base(v.type).k !== "map") return this.fail(p, "spread hanya untuk object sejenis");
        parts.push(v.code);
        constant = false;
        continue;
      }
      const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name) ? p.name.text : null;
      if (!key) return this.fail(p, "kunci object harus nama tetap");
      let v;
      if (ts.isPropertyAssignment(p)) v = this.expr(p.initializer, t.t.k === "any" ? null : t.t, ctx);
      else if (ts.isShorthandPropertyAssignment(p)) v = this.ident(p.name, ctx);
      else return this.fail(p, "properti object ini belum didukung");
      if (!/^(-?[\d.]+(e-?\d+)?|"(?:[^"\\]|\\.)*"|true|false|nil|xpMap\(.*\))$/.test(v.code)) constant = false;
      // kunci yang sama: yang terakhir menang (seperti JS); literal dictionary Swift tidak boleh dobel
      pending.delete(key);
      pending.set(key, `${swiftString(key)}: ${this.hostValue(v)}`);
    }
    flush();
    if (!parts.length) return { code: "xpMap([:])", type: t };
    const code = parts.length === 1 ? parts[0] : `xpMerge(${parts.join(", ")})`;
    if (constant && ctx.scope !== "module") return { code: this.hoist(code), type: t };
    return { code, type: t };
  }

  hoist(code) {
    if (this.hoistedByCode.has(code)) return this.hoistedByCode.get(code);
    const name = `S${this.hoisted.length + 1}`;
    this.hoisted.push(`    nonisolated(unsafe) static let ${name}: [String: Any?] = ${code}`);
    this.hoistedByCode.set(code, name);
    return name;
  }

  hostValue(v) {
    const b = base(v.type);
    const q = isOpt(v.type) ? "?" : "";
    if (b.k === "obj") return `${v.code}${q}.toHost()`;
    if (b.k === "list" && base(b.t).k === "obj") return `${v.code}${q}.map { $0${isOpt(b.t) ? "?" : ""}.toHost() }`;
    return v.code;
  }

  lambda(fn, ctx, retOverride, want) {
    const sig = this.checker.getSignatureFromDeclaration(fn);
    let ret = retOverride ?? this.mapType(sig.getReturnType(), fn);
    const wantFn = want && base(want).k === "fn" ? base(want) : null;
    if (wantFn && wantFn.ret.k === "void") ret = T.void;
    const inner = { ...ctx, ret, inLoop: false, update: null };
    const { params, pre } = this.fnParams(fn, "        ", inner, true);
    const body = [...pre];
    this.functionBody(fn, body, "        ", inner);
    const type = { k: "fn", params: fn.parameters.map((p) => this.typeOfNode(p.name)), ret };
    return { code: `{ (${params.join(", ")}) -> ${this.t.type(ret)} in\n${body.join("\n")}\n    }`, type };
  }

  /** `recv?.x()` untuk helper statis: dijalankan hanya kalau recv tidak nil. */
  optRecv(recv, fn, retOptional) {
    if (!isOpt(recv.type) || recv.type.k === "any") return fn(recv.code);
    return `${this.wrapCond(recv.code)}.${retOptional ? "flatMap" : "map"} { xpR in ${fn("xpR")} }`;
  }

  property(e, ctx) {
    const name = e.name.text;
    if (ts.isIdentifier(e.expression) && !this.names.has(this.symbolOf(e.expression))) {
      const g = e.expression.text;
      if (g === "Math" && name === "PI") return { code: "Double.pi", type: T.num };
      if (g === "Math" && name === "E") return { code: "2.718281828459045", type: T.num };
      if (g === "Number" && name === "MAX_SAFE_INTEGER") return { code: "9007199254740991.0", type: T.num };
      if (g === "Number" && name === "MIN_SAFE_INTEGER") return { code: "-9007199254740991.0", type: T.num };
      if (g === "Number" && name === "EPSILON") return { code: "Double.ulpOfOne", type: T.num };
      if (this.runtimeName(e.expression) == null) {
        const s = this.symbolOf(e.expression);
        if (s?.flags & ts.SymbolFlags.Enum) {
          const m = this.checker.getSymbolAtLocation(e);
          if (m && this.names.has(m)) return { code: this.names.get(m), type: this.typeOfNode(e) };
        }
        return this.fail(e, `'${g}.${name}' belum didukung di mode typed`);
      }
    }
    const obj = this.expr(e.expression, null, ctx);
    const optional = !!e.questionDotToken;
    const b = base(obj.type);
    const q = optional ? "?." : ".";
    const wrap = (code, t) => ({ code, type: optional ? opt(t) : t });
    if (name === "length" && (b.k === "str" || b.k === "list")) {
      const len = (s) => (b.k === "str" ? `XPStd.length(${s})` : `Double(${s}.count)`);
      return wrap(optional ? this.optRecv(obj, len, false) : len(obj.code), T.num);
    }
    if (b.k === "obj") {
      const f = b.cls.fields.find((x) => x.name === name);
      if (!f) return this.fail(e, `properti '${name}' tidak ada`);
      if (isOpt(obj.type) && !optional) return this.fail(e, "akses properti dari nilai yang bisa null; pakai ?.");
      return wrap(`${obj.code}${q}${f.id}`, f.t);
    }
    if (b.k === "env" && (name === "width" || name === "height" || name === "dark")) return wrap(`${obj.code}${q}${name}`, name === "dark" ? T.bool : T.num);
    if (b.k === "ref" && name === "current") return wrap(`${obj.code}${q}current`, b.t);
    if (b.k === "map") return wrap(`XPStd.get(${obj.code}, ${swiftString(name)})`, opt(b.t));
    return this.fail(e, `properti '${name}' pada ${b.k} belum didukung di mode typed`);
  }

  element(e, ctx) {
    const obj = this.expr(e.expression, null, ctx);
    const b = base(obj.type);
    const idx = this.expr(e.argumentExpression, null, ctx);
    if (b.k === "list" && idx.type.k === "num") {
      if (e.questionDotToken || isOpt(obj.type)) return { code: `XPStd.at(${obj.code}, ${idx.code})`, type: opt(b.t) };
      return { code: `${obj.code}[Int(${idx.code})]`, type: b.t };
    }
    if (b.k === "map" && idx.type.k === "str") return { code: `XPStd.get(${obj.code}, ${idx.code})`, type: opt(b.t) };
    if (b.k === "str" && idx.type.k === "num" && !isOpt(obj.type)) return { code: `XPStd.charAt(${obj.code}, ${idx.code})`, type: T.str };
    return this.fail(e, "akses indeks ini belum didukung di mode typed");
  }

  call(e, want, ctx) {
    const callee = e.expression;
    const rt = this.runtimeName(callee);
    if (rt && HOOKS.has(rt)) return this.hookCall(rt, e, ctx);
    if (ts.isIdentifier(callee) && !this.names.has(this.symbolOf(callee)) && !rt) {
      const g = this.globalCall(callee.text, e, ctx);
      if (g) return g;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const target = callee.expression;
      if (ts.isIdentifier(target) && !this.names.has(this.symbolOf(target)) && !this.runtimeName(target)) {
        const g = this.staticCall(target.text, callee.name.text, e, ctx);
        if (g) return g;
      }
      return this.methodCall(callee, e, want, ctx);
    }
    const f = this.expr(callee, null, ctx);
    const ft = base(f.type);
    if (ft.k === "setter") {
      const a = e.arguments[0];
      if (a && (ts.isArrowFunction(a) || ts.isFunctionExpression(a))) return { code: `${f.code}.update(${this.lambda(a, ctx, ft.t).code})`, type: T.void };
      return { code: `${f.code}(${a ? this.coerce(this.expr(a, ft.t, ctx), ft.t, a) : "nil"})`, type: T.void };
    }
    if (ft.k !== "fn") return this.fail(e, "yang dipanggil bukan fungsi bertipe");
    const sym = this.symbolOf(callee);
    const args = this.args(e, ctx, ft.params);
    if (sym && this.hookFns.has(sym)) {
      this.requireHooks(e, ctx);
      args.unshift("h");
    }
    // parameter opsional di akhir boleh tidak diisi di JS
    while (args.length < ft.params.length && isOpt(ft.params[args.length])) args.push("nil");
    const q = e.questionDotToken || isOpt(f.type) ? "?" : "";
    return { code: `${f.code}${q}(${args.join(", ")})`, type: q ? opt(ft.ret) : ft.ret };
  }

  hookCall(name, e, ctx) {
    this.requireHooks(e, ctx);
    const a = e.arguments;
    const deps = (node) => {
      if (!node) return "nil";
      if (!ts.isArrayLiteralExpression(node)) return this.fail(node, "deps hook harus array literal").code;
      const items = node.elements.map((x) => {
        const v = this.expr(x, null, ctx);
        const b = base(v.type);
        if (b.k === "fn" || b.k === "setter") return this.fail(x, "fungsi sebagai deps hook belum didukung di mode typed Swift (closure tidak punya identitas)").code;
        return v.code;
      });
      return `([${items.join(", ")}] as [Any?])`;
    };
    switch (name) {
      case "useEffect": {
        const fn = a[0];
        if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return this.fail(e, "useEffect butuh fungsi langsung");
        const body = [];
        const inner = { ...ctx, ret: { k: "opt", t: { k: "fn", params: [], ret: T.void } }, effect: true, inLoop: false, update: null };
        if (ts.isBlock(fn.body)) {
          this.block(fn.body.statements, body, "            ", inner);
          const last = fn.body.statements.at(-1);
          if (!last || !ts.isReturnStatement(last)) body.push("            return nil");
        } else {
          body.push(`            ${this.exprStatement(fn.body, inner)}`, "            return nil");
        }
        return { code: `h.effect(${deps(a[1])}) { () -> (() -> Void)? in\n${body.join("\n")}\n        }`, type: T.void };
      }
      case "useMemo": {
        const t = this.typeOfNode(e);
        return { code: `h.memo(${deps(a[1])}) ${this.call0Body(a[0], t, ctx)}`, type: t };
      }
      case "useCallback": {
        const t = this.typeOfNode(e);
        const fn = this.expr(a[0], t, ctx);
        return { code: `h.memo(${deps(a[1])}) { () -> ${this.t.type(fn.type)} in ${fn.code} }`, type: fn.type };
      }
      case "useRef": {
        const t = this.mapType(this.checker.getTypeOfSymbolAtLocation(this.checker.getPropertyOfType(this.checker.getTypeAtLocation(e), "current"), e), e);
        const init = a[0] ? this.expr(a[0], t, ctx).code : "nil";
        return { code: `h.ref { () -> ${this.t.type(t)} in ${init} }`, type: { k: "ref", t } };
      }
      case "environment":
        return { code: "h.env", type: T.env };
      case "useState":
        return this.fail(e, "hasil useState harus di-destructure: const [x, setX] = useState(...)");
    }
    return this.fail(e, `${name} belum didukung`);
  }

  call0Body(fn, ret, ctx) {
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return `{ ${this.fail(fn ?? fn, "butuh fungsi langsung").code} }`;
    if (!ts.isBlock(fn.body)) return `{ () -> ${this.t.type(ret)} in ${this.coerce(this.expr(fn.body, ret, ctx), ret, fn.body)} }`;
    return this.lambda(fn, ctx, ret).code;
  }

  globalCall(name, e, ctx) {
    const a = e.arguments;
    const one = (t) => (a[0] ? this.expr(a[0], t, ctx) : { code: "nil", type: T.void });
    switch (name) {
      case "String": return { code: this.toStr(one(null)), type: T.str };
      case "Number": return { code: `XPStd.num(${one(null).code})`, type: T.num };
      case "Boolean": return { code: this.truthy(one(null)), type: T.bool };
      case "parseInt": return { code: `XPStd.parseInt(${one(T.str).code}${a[1] ? `, ${this.expr(a[1], T.num, ctx).code}` : ""})`, type: T.num };
      case "parseFloat": return { code: `XPStd.parseFloat(${one(T.str).code})`, type: T.num };
      case "isNaN": return { code: `XPStd.num(${one(null).code}).isNaN`, type: T.bool };
      case "isFinite": return { code: `XPStd.num(${one(null).code}).isFinite`, type: T.bool };
    }
    if (TIMERS.has(name)) {
      this.requireHooks(e, ctx);
      if (name.startsWith("clear")) return { code: `h.${name}(${one(T.num).code})`, type: T.void };
      const fn = a[0];
      if (!fn) return this.fail(e, `${name} butuh fungsi`);
      const ms = a[1] ? this.expr(a[1], T.num, ctx).code : "0.0";
      return { code: `h.${name}(${ms}, ${this.lambda(fn, ctx, T.void).code})`, type: T.num };
    }
    return null;
  }

  staticCall(obj, name, e, ctx) {
    const args = (types) => this.args(e, ctx, types);
    if (obj === "Math") {
      const n = e.arguments.length;
      const num = (fnName) => ({ code: `${fnName}(${args(Array(n).fill(T.num)).join(", ")})`, type: T.num });
      switch (name) {
        case "round": return num("XPStd.round");
        case "floor": return num("Foundation.floor");
        case "ceil": return num("Foundation.ceil");
        case "abs": return num("Swift.abs");
        case "sqrt": return num("Foundation.sqrt");
        case "pow": return num("XPStd.pow");
        case "trunc": return num("XPStd.trunc");
        case "sign": return num("XPStd.sign");
        case "min": return n === 0 ? { code: "Double.infinity", type: T.num } : num("XPStd.min");
        case "max": return n === 0 ? { code: "-Double.infinity", type: T.num } : num("XPStd.max");
        case "random": return { code: "XPStd.random()", type: T.num };
        case "log": return num("Foundation.log");
        case "exp": return num("Foundation.exp");
        case "sin": return num("Foundation.sin");
        case "cos": return num("Foundation.cos");
        case "atan2": return num("Foundation.atan2");
        case "hypot": return num("XPStd.hypot");
      }
    }
    if (obj === "Date" && name === "now") return { code: "XPStd.now()", type: T.num };
    if (obj === "Number") {
      if (name === "isInteger") return { code: `XPStd.isInteger(${args([T.any])[0]})`, type: T.bool };
      if (name === "isFinite") return { code: `XPStd.isFiniteNum(${args([T.any])[0]})`, type: T.bool };
      if (name === "isNaN") return { code: `XPStd.isNaNNum(${args([T.any])[0]})`, type: T.bool };
      if (name === "parseFloat") return { code: `XPStd.parseFloat(${args([T.str])[0]})`, type: T.num };
      if (name === "parseInt") return { code: `XPStd.parseInt(${args([T.str, T.num]).join(", ")})`, type: T.num };
    }
    if (obj === "JSON" && name === "stringify") return { code: `XPStd.json(${this.hostValue(this.expr(e.arguments[0], null, ctx))})`, type: T.str };
    if (obj === "console") return { code: `XPStd.log(${swiftString(name)}${e.arguments.map((x) => ", " + this.hostValue(this.expr(x, null, ctx))).join("")})`, type: T.void };
    if (obj === "Object") return this.fail(e, `Object.${name} belum didukung di mode typed Swift (urutan kunci dictionary tidak tetap)`);
    if (obj === "Array" && name === "isArray") return { code: `XPStd.isArray(${this.expr(e.arguments[0], null, ctx).code})`, type: T.bool };
    return null;
  }

  methodCall(callee, e, want, ctx) {
    const recv = this.expr(callee.expression, null, ctx);
    const name = callee.name.text;
    const b = base(recv.type);
    const q = callee.questionDotToken ? "?." : ".";
    const wrapOpt = (r) => (callee.questionDotToken ? { code: r.code, type: opt(r.type) } : r);
    if (isOpt(recv.type) && recv.type.k !== "any" && !callee.questionDotToken) return this.fail(callee, "memanggil method dari nilai yang bisa null; pakai ?.");
    const a = e.arguments;
    if (b.k === "str") return wrapOpt(this.stringMethod(recv, q, name, e, ctx));
    if (b.k === "num") {
      const digits = a[0] ? this.expr(a[0], T.num, ctx).code : null;
      if (name === "toFixed") return wrapOpt({ code: this.optRecv(recv, (r) => `XPStd.toFixed(${r}, ${digits ?? "0.0"})`, false), type: T.str });
      if (name === "toString") return wrapOpt({ code: this.optRecv(recv, (r) => (digits ? `XPStd.toString(${r}, ${digits})` : `XPStd.str(${r})`), false), type: T.str });
    }
    if (b.k === "list") return wrapOpt(this.listMethod(recv, b, q, name, e, want, ctx));
    if (b.k === "regex" && name === "test") return { code: `XPStd.test(${recv.code}, ${this.expr(a[0], T.str, ctx).code})`, type: T.bool };
    return this.fail(e, `method '${name}' pada ${b.k} belum didukung di mode typed`);
  }

  stringMethod(recv, q, name, e, ctx) {
    const a = e.arguments;
    const arg = (i, t) => (a[i] ? this.expr(a[i], t, ctx).code : "nil");
    if (name === "toString") return { code: recv.code, type: T.str };
    if (name === "trim") return { code: this.optRecv(recv, (s) => `XPStd.trim(${s})`, false), type: T.str };
    if (name === "split" && !(a[0] && this.expr(a[0], null, ctx).type.k === "regex")) {
      return { code: this.optRecv(recv, (s) => `XPStd.split(${s}, ${arg(0, T.str)})`, false), type: { k: "list", t: T.str } };
    }
    // Method lain lewat implementasi JS yang sama dengan mode dinamis, supaya hasilnya persis.
    const ret = this.mapType(this.checker.getTypeAtLocation(e), e);
    const args = a.map((x) => {
      const v = this.expr(x, null, ctx);
      if (base(v.type).k === "fn") return this.fail(x, `callback di string.${name} belum didukung di mode typed`).code;
      return this.hostValue(v);
    });
    const raw = (s) => `XPStd.method(${s}, ${swiftString(name)}${args.length ? ", " + args.join(", ") : ""})`;
    const optional = isOpt(recv.type) && recv.type.k !== "any";
    return { code: this.optRecv(recv, (s) => this.fromDynamic(raw(s), base(ret)), optional && isOpt(ret)), type: ret };
  }

  fromDynamic(code, t) {
    switch (t.k) {
      case "str": return `(${code} as? String ?? "")`;
      case "num": return `XPStd.num(${code})`;
      case "bool": return `(${code} as? Bool ?? false)`;
      case "any": case "el": return code;
      case "opt":
        if (t.t.k === "list" && t.t.t.k === "str") return `XPStd.strList(${code})`;
        return `(${code} as? ${this.t.type(t.t)})`;
      case "list":
        if (t.t.k === "str") return `(XPStd.strList(${code}) ?? [])`;
        break;
    }
    return `(${code} as! ${this.t.type(t)})`;
  }

  listMethod(recv, b, q, name, e, want, ctx) {
    const a = e.arguments;
    const l = recv.code;
    const optional = isOpt(recv.type);
    const elemT = b.t;
    const cb = (i, ret) => {
      const fn = a[i];
      if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        const v = this.expr(fn, null, ctx);
        return { code: v.code, arity: base(v.type).params?.length ?? 1 };
      }
      return { code: this.lambda(fn, ctx, ret).code, arity: fn.parameters.length };
    };
    // callback dengan satu argumen (elemen); callback tanpa parameter tetap boleh seperti di JS
    const one = (c) => (c.arity === 0 ? `{ _ in (${c.code})() }` : c.code);
    const indexed = (c, f) => `${l}${q}enumerated().${f} { xpE in (${c.code})(xpE.element, Double(xpE.offset)) }`;
    const helper = (fn) => (optional ? this.fail(e, `array.${name} dari nilai yang bisa null belum didukung di mode typed Swift`).code : fn(l));
    switch (name) {
      case "map": {
        const ret = this.typeOfNode(e);
        const elRet = ret.k === "list" ? ret.t : T.any;
        const c = cb(0, elRet);
        return { code: c.arity >= 2 ? indexed(c, "map") : `${l}${q}map(${one(c)})`, type: ret.k === "list" ? ret : { k: "list", t: T.any } };
      }
      case "filter": {
        const c = cb(0, T.bool);
        return { code: c.arity >= 2 ? `${indexed(c, "filter")}.map { $0.element }` : `${l}${q}filter(${one(c)})`, type: b };
      }
      case "forEach": {
        const c = cb(0, T.void);
        return { code: c.arity >= 2 ? indexed(c, "forEach") : `${l}${q}forEach(${one(c)})`, type: T.void };
      }
      case "find": return { code: `${l}${q}first(where: ${one(cb(0, T.bool))})`, type: opt(elemT) };
      case "findIndex": return { code: helper((x) => `Double(${x}.firstIndex(where: ${one(cb(0, T.bool))}) ?? -1)`), type: T.num };
      case "some": return { code: `${l}${q}contains(where: ${one(cb(0, T.bool))})`, type: T.bool };
      case "every": return { code: `${l}${q}allSatisfy(${one(cb(0, T.bool))})`, type: T.bool };
      case "includes": return { code: helper((x) => `XPStd.includes(${x}, ${this.expr(a[0], elemT, ctx).code})`), type: T.bool };
      case "indexOf": return { code: helper((x) => `XPStd.indexOf(${x}, ${this.expr(a[0], elemT, ctx).code})`), type: T.num };
      case "join": return { code: helper((x) => `XPStd.join(${x}, ${a[0] ? this.expr(a[0], T.str, ctx).code : '","'})`), type: T.str };
      case "slice": return { code: helper((x) => `XPStd.slice(${x}${a.length ? ", " + a.map((y) => this.expr(y, T.num, ctx).code).join(", ") : ""})`), type: b };
      case "concat": return { code: helper((x) => `(${[x, ...a.map((y) => this.expr(y, b, ctx).code)].join(" + ")})`), type: b };
      case "reverse": case "toReversed": return { code: helper((x) => `Array(${x}.reversed())`), type: b };
      case "reduce": {
        if (!a[1]) return this.fail(e, "reduce butuh nilai awal di mode typed");
        const t = this.typeOfNode(e);
        const init = this.expr(a[1], t, ctx);
        const c = cb(0, t);
        return { code: helper((x) => `${x}.reduce(${init.code}) { xpAcc, xpX in (${c.code})(xpAcc, xpX) }`), type: t };
      }
    }
    return this.fail(e, `array.${name} belum didukung di mode typed`);
  }

  prefix(e, ctx) {
    const K = ts.SyntaxKind;
    switch (e.operator) {
      case K.ExclamationToken:
        return { code: `!${this.wrapCond(this.cond(e.operand, ctx))}`, type: T.bool };
      case K.MinusToken: {
        const v = this.expr(e.operand, T.num, ctx);
        if (v.type.k !== "num") return this.fail(e, "minus hanya untuk number");
        return { code: ts.isNumericLiteral(e.operand) ? swiftNum(-Number(e.operand.text)) : `-${v.code}`, type: T.num };
      }
      case K.PlusToken:
        return { code: `XPStd.num(${this.expr(e.operand, null, ctx).code})`, type: T.num };
      case K.TildeToken:
        return { code: `XPStd.bitNot(${this.expr(e.operand, T.num, ctx).code})`, type: T.num };
      default:
        return this.fail(e, "operator ini sebagai nilai belum didukung di mode typed");
    }
  }

  equals(a, b, node, negate = false) {
    const ta = base(a.type), tb = base(b.type);
    const prim = (t) => t.k === "num" || t.k === "str" || t.k === "bool";
    const nullable = (t) => isOpt(t) || t.k === "el" || t.k === "void";
    let code;
    if (a.type.k === "void" || b.type.k === "void") {
      const other = a.type.k === "void" ? b : a;
      if (other.type.k === "void") code = "true";
      else if (!nullable(other.type)) code = "false";
      else code = `${other.code} == nil`;
    } else if (prim(ta) && prim(tb)) code = ta.k !== tb.k ? "false" : `${a.code} == ${b.code}`;
    else if (ta.k === "any" || tb.k === "any" || ta.k === "el" || tb.k === "el") code = `XPStd.strictEquals(${a.code}, ${b.code})`;
    else if (ta.k === "obj" && tb.k === "obj") code = `${a.code} === ${b.code}`;
    else if (ta.k === "env" && tb.k === "env") code = `${a.code} == ${b.code}`;
    else return this.fail(node, `=== untuk ${ta.k} belum didukung di mode typed Swift`).code;
    if (negate) return code === "false" ? "true" : code === "true" ? "false" : `!(${code})`;
    return code;
  }

  binaryExpr(e, want, ctx) {
    const K = ts.SyntaxKind;
    const op = e.operatorToken.kind;
    switch (op) {
      case K.LessThanToken:
      case K.GreaterThanToken:
      case K.LessThanEqualsToken:
      case K.GreaterThanEqualsToken: {
        const l = this.expr(e.left, null, ctx), r = this.expr(e.right, null, ctx);
        if (l.type.k === "num" && r.type.k === "num") {
          const sym = { [K.LessThanToken]: "<", [K.GreaterThanToken]: ">", [K.LessThanEqualsToken]: "<=", [K.GreaterThanEqualsToken]: ">=" }[op];
          return { code: `(${l.code} ${sym} ${r.code})`, type: T.bool };
        }
        if (l.type.k === "str" && r.type.k === "str") {
          const fn = { [K.LessThanToken]: "lt", [K.GreaterThanToken]: "gt", [K.LessThanEqualsToken]: "le", [K.GreaterThanEqualsToken]: "ge" }[op];
          return { code: `XPStd.${fn}(${l.code}, ${r.code})`, type: T.bool };
        }
        return this.fail(e, "perbandingan hanya untuk dua number atau dua string");
      }
      case K.AmpersandAmpersandToken:
      case K.BarBarToken: {
        const l = this.expr(e.left, null, ctx);
        const r = this.expr(e.right, want, ctx);
        const and = op === K.AmpersandAmpersandToken;
        if (l.type.k === "bool" && r.type.k === "bool") return { code: `(${l.code} ${and ? "&&" : "||"} ${r.code})`, type: T.bool };
        const type = same(l.type, r.type) ? l.type : !and && same(base(l.type), r.type) ? r.type : r.type.k === "el" && l.type.k === "bool" ? T.el : T.any;
        const ty = this.t.type(type);
        const cast = (c) => (same(type, l.type) && same(type, r.type) ? c : `(${c} as ${ty})`);
        if (l.type.k === "bool") return { code: and ? `(${l.code} ? ${cast(r.code)} : ${cast("false")})` : `(${l.code} ? ${cast("true")} : ${cast(r.code)})`, type };
        const t = this.tmp("v");
        const lt = this.truthy({ code: t, type: l.type });
        return { code: `{ () -> ${ty} in let ${t} = ${l.code}; return ${lt} ? ${cast(and ? r.code : t)} : ${cast(and ? t : r.code)} }()`, type };
      }
      case K.QuestionQuestionToken: {
        const l = this.expr(e.left, null, ctx);
        const r = this.expr(e.right, base(l.type), ctx);
        return { code: `(${l.code} ?? ${r.code})`, type: isOpt(r.type) ? l.type : base(l.type) };
      }
    }
    return super.binaryExpr(e, want, ctx);
  }

  binary(e, op, ctx) {
    const K = ts.SyntaxKind;
    const l = this.expr(e.left, null, ctx), r = this.expr(e.right, null, ctx);
    if (op === K.PlusToken && (l.type.k === "str" || r.type.k === "str")) return { code: this.interpolate([this.toStr(l), this.toStr(r)]), type: T.str };
    if (l.type.k !== "num" || r.type.k !== "num") return this.fail(e, `operator ${K[op]} hanya untuk number di mode typed`);
    switch (op) {
      case K.PercentToken: return { code: `XPStd.mod(${l.code}, ${r.code})`, type: T.num };
      case K.AsteriskAsteriskToken: return { code: `XPStd.pow(${l.code}, ${r.code})`, type: T.num };
    }
    return super.binary(e, op, ctx);
  }

  // --- JSX ---

  jsx(e, ctx) {
    if (ts.isJsxFragment(e)) return { code: this.children(e.children, ctx) ?? "nil", type: T.el };
    const opening = ts.isJsxElement(e) ? e.openingElement : e;
    const tag = opening.tagName;
    const rt = ts.isIdentifier(tag) ? this.runtimeName(tag) : null;
    if (rt === "Fragment") return { code: this.children(ts.isJsxElement(e) ? e.children : [], ctx) ?? "nil", type: T.el };
    return super.jsx(e, ctx);
  }

  children(nodes, ctx) {
    const items = [];
    for (const c of nodes) {
      if (ts.isJsxText(c)) {
        const text = jsxText(decodeEntities(c.text));
        if (text) items.push(swiftString(text));
        continue;
      }
      if (ts.isJsxExpression(c)) {
        if (!c.expression) continue;
        if (c.dotDotDotToken) {
          this.fail(c, "spread children belum didukung");
          continue;
        }
        items.push(this.childValue(c.expression, ctx));
        continue;
      }
      items.push(this.expr(c, T.el, ctx).code);
    }
    if (!items.length) return null;
    return items.length === 1 ? items[0] : `([\n${items.join(",\n")},\n] as [Any?])`;
  }

  primitive(name, opening, children, ctx) {
    const props = new Map();
    const handlers = [];
    let key = null;
    let className = null;
    for (const attr of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) {
        this.fail(attr, "spread props belum didukung di mode typed");
        continue;
      }
      const prop = attr.name.text;
      const init = attr.initializer;
      const valueNode = !init ? null : ts.isJsxExpression(init) ? init.expression : init;
      if (prop === "className") {
        if (!this.classTable) {
          this.fail(attr, "className butuh tabel class dari xp build");
          continue;
        }
        this.requireHooks(attr, ctx);
        const v = valueNode ? this.expr(valueNode, T.str, ctx) : { code: '""', type: T.str };
        if (base(v.type).k !== "str") this.fail(attr, "className harus string");
        this.usesClasses = true;
        className = v.code;
        continue;
      }
      if (prop === "key") {
        key = this.toStr(valueNode ? this.expr(valueNode, null, ctx) : { code: '"true"', type: T.str });
        continue;
      }
      if (prop === "children") {
        this.fail(attr, "prop children belum didukung di mode typed; tulis sebagai isi tag");
        continue;
      }
      const declType = this.checker.getContextualType(valueNode ?? attr);
      const want = declType ? this.mapType(declType, attr) : null;
      if (want && base(want).k === "fn") {
        handlers.push(`${swiftString(prop)}: ${this.handler(valueNode, base(want), ctx)}`);
        continue;
      }
      const v = valueNode ? this.expr(valueNode, want, ctx) : { code: "true", type: T.bool };
      props.delete(prop);
      props.set(prop, `${swiftString(prop)}: ${this.hostValue(v)}`);
    }
    const kids = this.children(children, ctx);
    const list = [...props.values()];
    const parts = [swiftString(name)];
    const dict = list.length ? `[${list.join(", ")}]` : "[:]";
    if (className) parts.push(`props: XPClassName.props(CLS, h, xpProps(${dict}), ${className})`);
    else if (list.length) parts.push(`props: xpProps(${dict})`);
    if (handlers.length) parts.push(`handlers: [${handlers.join(", ")}]`);
    if (key) parts.push(`key: ${key}`);
    if (kids) parts.push(`children: ${kids}`);
    return { code: `el(${parts.join(", ")})`, type: T.el };
  }

  handler(valueNode, fnType, ctx) {
    const cast = (t, i, node) => {
      const a = `XPStd.arg(a, ${i})`;
      switch (base(t).k) {
        case "str": return isOpt(t) ? `(${a} as? String)` : `(${a} as? String ?? "")`;
        case "num": return isOpt(t) ? `XPStd.numOrNull(${a})` : `XPStd.num(${a})`;
        case "bool": return isOpt(t) ? `(${a} as? Bool)` : `(${a} as? Bool ?? false)`;
        case "any": case "el": return a;
        case "map": return `XPStd.map(${a})`;
        default: return this.fail(node, `argumen event bertipe ${base(t).k} belum didukung di mode typed Swift`).code;
      }
    };
    if (ts.isArrowFunction(valueNode) || ts.isFunctionExpression(valueNode)) {
      const inner = { ...ctx, ret: T.void, inLoop: false, update: null };
      const body = [];
      valueNode.parameters.forEach((p, i) => {
        const pt = this.typeOfNode(p.name);
        if (ts.isIdentifier(p.name)) body.push(`            let ${this.nameFor(this.symbolOf(p.name), p.name.text)}: ${this.t.type(pt)} = ${cast(pt, i, p)}`);
        else this.fail(p, "destructuring parameter handler belum didukung");
      });
      if (ts.isBlock(valueNode.body)) this.block(valueNode.body.statements, body, "            ", inner);
      else body.push(`            ${this.exprStatement(valueNode.body, inner)}`);
      return `{ (a: [Any?]) in\n${body.join("\n")}\n        }`;
    }
    const f = this.expr(valueNode, fnType, ctx);
    const ft = base(f.type);
    if (ft.k === "setter") return `{ (a: [Any?]) in ${f.code}(${cast(ft.t, 0, valueNode)}) }`;
    if (ft.k !== "fn") return this.fail(valueNode, "handler harus fungsi").code;
    const args = ft.params.map((t, i) => cast(t, i, valueNode));
    const call = `${f.code}${isOpt(f.type) ? "?" : ""}(${args.join(", ")})`;
    return `{ (a: [Any?]) in ${ft.ret.k === "void" ? call : `_ = ${call}`} }`;
  }

  userComponent(sym, tag, opening, children, ctx) {
    const info = this.components.get(sym) ?? this.pendingComponent(sym, tag);
    if (!info) return this.fail(tag, `'${tag.getText()}' bukan komponen yang bisa dikompilasi`);
    let key = null;
    const values = new Map();
    for (const attr of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) {
        this.fail(attr, "spread props belum didukung di mode typed");
        continue;
      }
      const prop = attr.name.text;
      const init = attr.initializer;
      const valueNode = !init ? null : ts.isJsxExpression(init) ? init.expression : init;
      if (prop === "key") {
        key = valueNode ? this.toStr(this.expr(valueNode, null, ctx)) : '"true"';
        continue;
      }
      const field = info.cls?.fields.find((f) => f.name === prop);
      if (!field) {
        this.fail(attr, `prop '${prop}' tidak ada di props ${tag.getText()}`);
        continue;
      }
      values.set(prop, valueNode ? this.coerce(this.expr(valueNode, field.t, ctx), field.t, valueNode) : "true");
    }
    const kids = this.children(children, ctx);
    if (kids) {
      const field = info.cls?.fields.find((f) => f.name === "children");
      if (!field) this.fail(opening, `${tag.getText()} tidak menerima children`);
      else values.set("children", kids);
    }
    let propsCode = "()";
    if (info.cls) {
      const args = info.cls.fields.map((f) => (values.has(f.name) ? values.get(f.name) : isOpt(f.t) ? "nil" : this.fail(opening, `prop '${f.name}' wajib diisi`).code));
      propsCode = `${info.cls.name}(${args.join(", ")})`;
    }
    return { code: `comp(${swiftString(info.name)}, ${key ?? "nil"}, ${propsCode}) { p, h in ${info.name}(p, h) }`, type: T.el };
  }
}

/** Class Swift untuk type alias / interface, dengan konversi dari/ke dictionary (props app, renderer). */
function swiftClass(cls, t) {
  const fromHost = (ft, v) => {
    const b = base(ft);
    const o = isOpt(ft);
    switch (b.k) {
      case "num": return o ? `XPStd.numOrNull(${v})` : `XPStd.num(${v})`;
      case "str": return o ? `(${v} as? String)` : `(${v} as? String ?? "")`;
      case "bool": return o ? `(${v} as? Bool)` : `(${v} as? Bool ?? false)`;
      case "obj": return o ? `(${v} == nil ? nil : ${b.cls.name}.fromHost(${v}))` : `${b.cls.name}.fromHost(${v})`;
      case "list": {
        const inner = fromHost(b.t, "$0");
        return o ? `(${v} as? [Any?])?.map { ${inner} }` : `((${v} as? [Any?]) ?? []).map { ${inner} }`;
      }
      case "map": return `XPStd.map(${v})`;
      case "any": case "el": return v;
      default: return `(${v} as! ${t.type(ft)})`;
    }
  };
  const toHost = (ft, v) => {
    const b = base(ft);
    if (b.k === "obj") return `${v}${isOpt(ft) ? "?" : ""}.toHost()`;
    if (b.k === "list" && base(b.t).k === "obj") return `${v}${isOpt(ft) ? "?" : ""}.map { ${toHost(b.t, "$0")} }`;
    return v;
  };
  const f = cls.fields;
  return [
    `    final class ${cls.name}: XPHostValue {`,
    ...f.map((x) => `        var ${x.id}: ${t.type(x.t)}`),
    "",
    `        init(${f.map((x) => `_ ${x.id}: ${t.param(x.t)}`).join(", ")}) {`,
    ...f.map((x) => `            self.${x.id} = ${x.id}`),
    "        }",
    "",
    `        func toHost() -> [String: Any?] { xpProps([${f.length ? f.map((x) => `${swiftString(x.name)}: ${toHost(x.t, x.id)}`).join(", ") : ":"}]) }`,
    "",
    `        static func fromHost(_ v: Any?) -> ${cls.name} {`,
    `            let m = XPStd.map(v)`,
    `            return ${cls.name}(${f.map((x) => fromHost(x.t, `XPStd.get(m, ${swiftString(x.name)})`)).join(", ")})`,
    "        }",
    "    }",
  ];
}

/** Indentasi kode Swift sesuai kedalaman kurung (string dan interpolasi `\(...)` dilewati). */
function reindent(code) {
  let depth = 0;
  const out = [];
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (!line) {
      out.push("");
      continue;
    }
    let open = 0, close = 0, leading = 0, seenOther = false;
    const skipString = (i) => {
      // i di tanda kutip pembuka; kembalikan posisi kutip penutup
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && line[i + 1] === "(") {
          let d = 1;
          i += 2;
          while (i < line.length && d > 0) {
            if (line[i] === '"') i = skipString(i);
            else if (line[i] === "(") d++;
            else if (line[i] === ")") d--;
            i++;
          }
          continue;
        }
        i += line[i] === "\\" ? 2 : 1;
      }
      return i;
    };
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        i = skipString(i);
        seenOther = true;
        continue;
      }
      if (ch === "{" || ch === "(" || ch === "[") {
        open++;
        seenOther = true;
      } else if (ch === "}" || ch === ")" || ch === "]") {
        if (!seenOther) leading++;
        else if (open > 0) open--;
        else close++;
      } else if (ch !== " ") seenOther = true;
    }
    depth = Math.max(0, depth - leading);
    out.push("    ".repeat(depth) + line);
    depth = Math.max(0, depth + open - close);
  }
  return out.join("\n");
}

/**
 * Rapikan hasil supaya Xcode tidak memberi peringatan: `var` yang tidak pernah diubah → `let`,
 * nilai yang tidak dipakai → `_`. Nama di kode hasil unik per file (lihat Compiler.nameFor).
 */
function tidy(code) {
  const stripped = code.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const count = (name) => (stripped.match(new RegExp(`(?<![\\w.])${name}\\b`, "g")) ?? []).length;
  const assigned = (name) => new RegExp(`(?<![\\w.])${name}\\s*(=(?!=)|\\+=|-=)`).test(stripped.replace(new RegExp(`(var|let) ${name}\\b[^\\n]*`, "g"), ""));
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(nonisolated|static|final|public|@)/.test(line)) continue;
    let m = /^(\s*)let \((\w+), (\w+)\) = (.*)$/.exec(line);
    if (m) {
      const [, ind, a, b, rest] = m;
      const na = a !== "_" && count(a) === 1 ? "_" : a;
      const nb = b !== "_" && count(b) === 1 ? "_" : b;
      lines[i] = na === "_" && nb === "_" ? `${ind}_ = ${rest}` : `${ind}let (${na}, ${nb}) = ${rest}`;
      continue;
    }
    m = /^(\s*)for (\w+) in (.*)$/.exec(line);
    if (m && count(m[2]) === 1) {
      lines[i] = `${m[1]}for _ in ${m[3]}`;
      continue;
    }
    m = /^(\s*)(let|var) (\w+): [^=]+= (.*)$/.exec(line);
    if (!m) continue;
    const [, ind, kw, name, value] = m;
    if (count(name) === 1) {
      lines[i] = value === "nil" ? "" : `${ind}_ = ${value}`;
      continue;
    }
    if (kw === "var" && !assigned(name)) lines[i] = line.replace(/^(\s*)var /, "$1let ");
  }
  return lines.filter((l, i) => !(l === "" && lines[i - 1] === "" )).join("\n");
}

/**
 * Kompilasi satu komponen ke Swift bertipe.
 * @returns {{ code: string, typeName: string, hash: string }}
 */
export function compileTypedSwift({ file, name, projectDir, classes = null }) {
  const { c, body, root, hash, typeName } = compileModules({ file, name, projectDir, classes, CompilerClass: SwiftCompiler, target: swift });
  const classDecls = c.classOrder.flatMap((cls) => [...swiftClass(cls, swift), ""]);
  const rootCall = root.cls ? `${typeName}.${root.name}(${root.cls.name}.fromHost(props), h)` : `${typeName}.${root.name}((), h)`;
  const code = tidy(
    reindent(`// Dibuat oleh xp build dari ${swiftString(name)} (mode typed). Jangan diubah manual.
import Foundation
import XPKit

public final class ${typeName}: XPTypedComponent {
    public let name = ${swiftString(name)}
    public let hash = ${swiftString(hash)}

    public init() {}

${c.usesClasses ? `    nonisolated(unsafe) static let CLS = XPClassName.table(${swiftString(JSON.stringify(classes))})\n\n` : ""}${classDecls.join("\n")}${c.hoisted.join("\n")}${c.hoisted.length ? "\n\n" : ""}${body.join("\n")}
    public func render(_ props: [String: Any?], _ h: XPHooks) -> Any? {
        ${rootCall}
    }
}
`),
  );
  return { code, typeName, hash };
}
