// Komponen @xp/runtime → Kotlin/Swift bertipe.
//
// Berbeda dengan native-kotlin.mjs (yang menerjemahkan bundle JS apa adanya dengan nilai dinamis),
// compiler ini membaca file .tsx asli dengan type-checker TypeScript dan menulis kode dengan tipe
// yang jelas: `number` → Double, `string` → String, type alias / interface → class, array → List.
// UI menjadi elemen (`el("View", ...)`) yang dirender langsung oleh runtime typed di SDK
// (XPTyped.kt / XPTyped.swift), tanpa engine JS, tanpa daftar operasi, tanpa XPTree.
//
// Yang tidak bisa diberi tipe dengan pasti (any, union campuran, class, library npm, className,
// ...) membuat seluruh komponen ditolak dengan lokasi di file .tsx; xp build lalu memakai jalur
// dinamis (native-kotlin.mjs / native-swift.mjs) untuk komponen itu.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.resolve(here, "..", "runtime");

export class TypedCompileError extends Error {}

export const PRIMITIVES = new Set(["View", "Text", "Image", "Pressable", "ScrollView", "TextInput", "Modal", "NativeView"]);
export const HOOKS = new Set(["useState", "useEffect", "useMemo", "useCallback", "useRef", "environment"]);
export const TIMERS = new Set(["setTimeout", "setInterval", "clearTimeout", "clearInterval"]);

const KOTLIN_KEYWORDS = new Set(
  "as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where actual abstract annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg value it".split(
    " ",
  ),
);

/** Nama tipe komponen, mis. "promo-modal" → "XPT_PromoModal". */
export function typedName(name) {
  return "XPT_" + name.split(/[^A-Za-z0-9]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join("");
}

// --- tipe ---
// { k: "num" | "str" | "bool" | "void" | "any" | "el" | "env" | "regex" }
// { k: "opt", t } { k: "list", t } { k: "map", t } { k: "obj", cls } { k: "fn", params, ret }
// { k: "setter", t } { k: "ref", t }

export const T = {
  num: { k: "num" },
  str: { k: "str" },
  bool: { k: "bool" },
  void: { k: "void" },
  any: { k: "any" },
  el: { k: "el" },
  env: { k: "env" },
  regex: { k: "regex" },
};
export const opt = (t) => (t.k === "opt" || t.k === "any" || t.k === "el" ? t : { k: "opt", t });
export const base = (t) => (t.k === "opt" ? t.t : t);
export const isOpt = (t) => t.k === "opt" || t.k === "any";
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function kotlinString(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "$") out += "\\$";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || (c >= 0x7f && c < 0xa0)) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else if (c > 0xffff) out += ch;
    else out += ch;
  }
  return out + '"';
}

function kotlinNum(n) {
  if (Number.isNaN(n)) return "Double.NaN";
  if (n === Infinity) return "Double.POSITIVE_INFINITY";
  if (n === -Infinity) return "Double.NEGATIVE_INFINITY";
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return `${n}.0`;
  const s = String(n);
  return /[.e]/.test(s) ? s.replace("e+", "e") : `${s}.0`;
}

// --- target Kotlin ---
const kotlin = {
  name: "kotlin",
  str: kotlinString,
  num: kotlinNum,
  nil: "null",
  bang: "!!",
  ident(n) {
    if (/^_+$/.test(n)) return "unused";
    return KOTLIN_KEYWORDS.has(n) ? `${n}_` : n.replace(/\$/g, "_S");
  },
  type(t) {
    switch (t.k) {
      case "num": return "Double";
      case "str": return "String";
      case "bool": return "Boolean";
      case "void": return "Unit";
      case "any": return "Any?";
      case "el": return "Any?";
      case "env": return "XPEnv";
      case "regex": return "Any";
      case "opt": {
        const inner = this.type(t.t);
        return inner.endsWith("?") ? inner : `${inner}?`;
      }
      case "list": return `List<${this.type(t.t)}>`;
      case "map": return `Map<String, ${this.type(t.t)}>`;
      case "obj": return t.cls.name;
      case "fn": return `(${t.params.map((p) => this.type(p)).join(", ")}) -> ${this.type(t.ret)}`;
      case "setter": return `XPSetter<${this.type(t.t)}>`;
      case "ref": return `XPRef<${this.type(t.t)}>`;
      default: throw new Error(`tipe ${t.k}`);
    }
  },
};

/** Normalisasi teks JSX seperti TypeScript/esbuild: baris dipangkas, baris kosong dibuang, digabung spasi. */
export function jsxText(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  if (lines.length === 1) return raw;
  let out = "";
  lines.forEach((line, i) => {
    let l = line.replace(/\t/g, " ");
    if (i !== 0) l = l.replace(/^[ ]+/, "");
    if (i !== lines.length - 1) l = l.replace(/[ ]+$/, "");
    if (!l) return;
    out += (out ? " " : "") + l;
  });
  return out;
}

export function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

export class Compiler {
  constructor(program, entry, projectDir, target) {
    this.program = program;
    this.checker = program.getTypeChecker();
    this.entry = entry;
    this.projectDir = projectDir;
    this.t = target;
    this.errors = [];
    this.classes = new Map(); // key → cls
    this.classOrder = [];
    this.names = new Map(); // symbol → nama di kode hasil
    this.used = new Set();
    this.hoisted = []; // konstanta style yang diangkat ke level object
    this.hoistedByCode = new Map();
    this.counter = 0;
  }

  // --- utilitas ---

  fail(node, reason) {
    const sf = node.getSourceFile();
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const rel = path.relative(this.projectDir, sf.fileName).split(path.sep).join("/");
    this.errors.push(`${rel}:${line + 1}:${character + 1} ${reason}`);
    return { code: this.t.nil, type: T.any };
  }

  tmp(prefix = "t") {
    return `${prefix}${++this.counter}`;
  }

  isRuntimeFile(sf) {
    return path.resolve(sf.fileName).startsWith(RUNTIME + path.sep);
  }

  symbolOf(node) {
    let s = this.checker.getSymbolAtLocation(node);
    if (s && s.flags & ts.SymbolFlags.Alias) s = this.checker.getAliasedSymbol(s);
    return s;
  }

  /** Simbol yang diekspor runtime (@xp/runtime), atau null. */
  runtimeName(node) {
    const s = this.symbolOf(node);
    if (!s || !s.declarations?.length) return null;
    return s.declarations.some((d) => this.isRuntimeFile(d.getSourceFile())) ? s.name : null;
  }

  /** Nama variabel/fungsi di kode hasil. */
  nameFor(sym, wanted) {
    if (this.names.has(sym)) return this.names.get(sym);
    let n = this.t.ident(wanted);
    if (this.used.has(n)) {
      let i = 2;
      while (this.used.has(`${n}${i}`)) i++;
      n = `${n}${i}`;
    }
    this.used.add(n);
    this.names.set(sym, n);
    return n;
  }

  // --- tipe TypeScript → tipe kode hasil ---

  typeOfNode(node) {
    return this.mapType(this.checker.getTypeAtLocation(node), node);
  }

  mapType(type, node) {
    const c = this.checker;
    const f = type.flags;
    if (f & ts.TypeFlags.Any || f & ts.TypeFlags.Unknown) return T.any;
    if (f & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) return T.num;
    if (f & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral | ts.TypeFlags.TemplateLiteral)) return T.str;
    if (f & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) return T.bool;
    if (f & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null)) return T.void;
    if (f & ts.TypeFlags.Never) return T.void;
    if (f & ts.TypeFlags.EnumLiteral || f & ts.TypeFlags.Enum) {
      return type.isUnion?.() ? this.mapType(type.types[0], node) : (f & ts.TypeFlags.NumberLike ? T.num : T.str);
    }
    if (type.isUnion()) {
      const parts = type.types.filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)));
      const nullable = parts.length !== type.types.length;
      if (!parts.length) return T.void;
      // boolean = true | false
      const mapped = parts.map((p) => this.mapType(p, node));
      const first = mapped[0];
      if (mapped.every((m) => same(m, first))) return nullable ? opt(first) : first;
      if (mapped.some((m) => m.k === "el") && mapped.every((m) => m.k === "el" || m.k === "void" || m.k === "bool" || m.k === "str" || m.k === "num")) return T.el;
      if (mapped.some((m) => m.k === "any")) return T.any;
      this.fail(node, `tipe '${c.typeToString(type)}' bukan satu tipe yang pasti`);
      return T.any;
    }
    const calls = type.getCallSignatures();
    if (calls.length) {
      const sig = calls[0];
      return {
        k: "fn",
        params: sig.getParameters().map((p) => this.mapType(c.getTypeOfSymbolAtLocation(p, node), node)),
        ret: this.mapType(sig.getReturnType(), node),
      };
    }
    const sym = type.aliasSymbol ?? type.getSymbol();
    const name = sym?.name;
    if (sym?.declarations?.some((d) => this.isRuntimeFile(d.getSourceFile()))) {
      if (name === "VNode" || name === "Element") return T.el;
      if (name === "Environment") return T.env;
      // Style, Entering, dan props primitive lain: dikirim ke renderer sebagai map.
      return { k: "map", t: T.any };
    }
    if (name === "Element" && sym?.parent?.name === "JSX") return T.el;
    if (name === "RegExp") return T.regex;
    if (c.isArrayType(type) || c.isTupleType?.(type)) {
      if (c.isTupleType?.(type)) {
        this.fail(node, "tuple belum didukung di mode typed");
        return T.any;
      }
      const [elem] = c.getTypeArguments(type);
      return { k: "list", t: this.mapType(elem, node) };
    }
    if (f & ts.TypeFlags.Object) {
      const index = type.getStringIndexType();
      if (index && !type.getProperties().length) return { k: "map", t: this.mapType(index, node) };
      if (name === "Record" || (index && type.getProperties().length === 0)) return { k: "map", t: index ? this.mapType(index, node) : T.any };
      return { k: "obj", cls: this.classFor(type, node) };
    }
    this.fail(node, `tipe '${c.typeToString(type)}' belum didukung di mode typed`);
    return T.any;
  }

  /** Type alias / interface / object literal type → class. */
  classFor(type, node) {
    const c = this.checker;
    const props = type.getProperties();
    const alias = type.aliasSymbol?.name ?? (type.getSymbol()?.name !== "__type" && type.getSymbol()?.name !== "__object" ? type.getSymbol()?.name : null);
    const key = alias ? `alias:${alias}:${props.map((p) => p.name).join(",")}` : `shape:${props.map((p) => `${p.name}:${c.typeToString(c.getTypeOfSymbolAtLocation(p, node))}`).join(";")}`;
    if (this.classes.has(key)) return this.classes.get(key);
    const cls = { name: alias ? this.t.ident(alias) : `Obj${this.classes.size + 1}`, fields: [], key };
    if ([...this.classes.values()].some((x) => x.name === cls.name)) cls.name = `${cls.name}${this.classes.size + 1}`;
    this.classes.set(key, cls);
    for (const p of props) {
      const decl = p.valueDeclaration ?? p.declarations?.[0];
      const optional = !!(p.flags & ts.SymbolFlags.Optional);
      let t = this.mapType(c.getTypeOfSymbolAtLocation(p, decl ?? node), decl ?? node);
      if (optional) t = opt(t);
      cls.fields.push({ name: p.name, id: this.t.ident(p.name), t });
    }
    this.classOrder.push(cls);
    return cls;
  }

  // --- modul ---

  collectModules() {
    const mods = [];
    const seen = new Set();
    const visit = (sf) => {
      if (seen.has(sf.fileName)) return;
      seen.add(sf.fileName);
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st)) continue;
        const spec = st.moduleSpecifier.text;
        // import "./styles/tw.css": hanya untuk build (tabel className), tidak ada kode
        if (!st.importClause && /\.(css|scss|sass|less)$/.test(spec)) continue;
        if (spec === "@xp/runtime" || spec.startsWith("@xp/runtime/")) continue;
        if (!spec.startsWith(".")) {
          this.fail(st, `import '${spec}' (library npm) belum didukung di mode typed`);
          continue;
        }
        const resolved = ts.resolveModuleName(spec, sf.fileName, this.program.getCompilerOptions(), ts.sys).resolvedModule;
        const target = resolved && this.program.getSourceFile(resolved.resolvedFileName);
        if (!target) {
          this.fail(st, `modul '${spec}' tidak ditemukan`);
          continue;
        }
        visit(target);
      }
      mods.push(sf);
    };
    visit(this.program.getSourceFile(this.entry));
    return mods;
  }

  // --- deklarasi level modul ---

  isComponentFn(name, fnNode) {
    if (!name || !/^[A-Z]/.test(name)) return false;
    const sig = this.checker.getSignatureFromDeclaration(fnNode);
    if (!sig) return false;
    const ret = this.mapType(sig.getReturnType(), fnNode);
    return base(ret).k === "el" || ret.k === "void";
  }

  module(sf, out) {
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) continue;
      if (ts.isExportDeclaration(st)) {
        if (st.moduleSpecifier) this.fail(st, "re-export belum didukung di mode typed");
        continue;
      }
      if (ts.isFunctionDeclaration(st)) {
        out.push(...this.functionDecl(st, "    "), "");
        if (st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) && sf.fileName === this.entry) this.defaultExport = st;
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
          const sym = this.symbolOf(d.name);
          const name = this.nameFor(sym, d.name.text);
          const type = this.typeOfNode(d.name);
          const mutable = !(st.declarationList.flags & ts.NodeFlags.Const);
          const value = init ? this.expr(init, type, { scope: "module" }).code : this.t.nil;
          out.push(`    ${mutable ? "var" : "val"} ${name}: ${this.t.type(type)} = ${value}`);
        }
        continue;
      }
      if (ts.isExportAssignment(st)) {
        if (sf.fileName === this.entry) {
          const s = this.symbolOf(st.expression);
          this.defaultExportSymbol = s;
        }
        continue;
      }
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
      const sym = this.checker.getSymbolAtLocation(m.name);
      const name = this.nameFor(sym, `${st.name.text}_${m.name.text}`);
      let value;
      if (m.initializer) {
        const v = this.checker.getConstantValue(m);
        if (v === undefined) {
          this.fail(m, "nilai enum harus konstanta");
          continue;
        }
        value = v;
      } else value = next;
      if (typeof value === "number") next = value + 1;
      out.push(`    val ${name}: ${typeof value === "number" ? "Double" : "String"} = ${typeof value === "number" ? kotlinNum(value) : kotlinString(value)}`);
    }
  }

  /** Fungsi level modul: komponen (props, h), custom hook (h, ...), atau fungsi biasa. */
  functionDecl(fn, ind, nameNode = fn.name) {
    if (fn.asteriskToken) return [this.fail(fn, "generator belum didukung").code];
    if (fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return [this.fail(fn, "async belum didukung di mode typed").code];
    const jsName = nameNode?.text ?? "default";
    const sym = nameNode ? this.symbolOf(nameNode) : fn.symbol;
    const name = this.nameFor(sym ?? fn, jsName);
    const isComp = this.isComponentFn(jsName, fn);
    const isHook = /^use[A-Z]/.test(jsName);
    const sig = this.checker.getSignatureFromDeclaration(fn);
    const ret = isComp ? T.el : this.mapType(sig.getReturnType(), fn);
    const ctx = { scope: "fn", hooks: isComp || isHook, ret, fn };
    const head = [];
    const body = [];
    const params = [];
    if (isComp) {
      if (fn.parameters.length > 1) this.fail(fn, "komponen hanya punya satu parameter props");
      const p = fn.parameters[0];
      if (p) {
        const pt = this.typeOfNode(p.name);
        if (pt.k !== "obj") this.fail(p, "props komponen harus berupa object dengan tipe yang jelas");
        params.push(`p: ${this.t.type(pt)}`);
        this.bindParam(p, "p", pt, body, ind + "    ", ctx);
        if (pt.k === "obj") this.componentProps.set(name, pt.cls);
      } else {
        params.push("p: Unit");
      }
      params.push("h: XPHooks");
      this.components.set(sym ?? fn, { name, cls: p ? this.typeOfNode(p.name).cls : null });
    } else {
      if (isHook) params.push("h: XPHooks");
      fn.parameters.forEach((p, i) => {
        if (p.dotDotDotToken) this.fail(p, "parameter rest belum didukung di mode typed");
        let pt = this.typeOfNode(p.name);
        if (p.questionToken || p.initializer) pt = p.initializer ? pt : opt(pt);
        if (ts.isIdentifier(p.name) && !p.initializer) {
          const n = this.nameFor(this.symbolOf(p.name), p.name.text);
          params.push(`${n}: ${this.t.type(pt)}`);
        } else {
          const raw = `a${i}`;
          params.push(`${raw}: ${this.t.type(p.initializer ? opt(pt) : pt)}`);
          this.bindParam(p, raw, pt, body, ind + "    ", ctx);
        }
      });
    }
    head.push(`${ind}fun ${name}(${params.join(", ")}): ${this.t.type(ret)} {`);
    this.functionBody(fn, body, ind + "    ", ctx);
    return [...head, ...body, `${ind}}`];
  }

  /** Parameter dengan destructuring / nilai default. */
  bindParam(p, raw, pt, out, ind, ctx) {
    if (ts.isIdentifier(p.name)) {
      const n = this.nameFor(this.symbolOf(p.name), p.name.text);
      const value = p.initializer ? `${raw} ?: ${this.expr(p.initializer, base(pt), ctx).code}` : raw;
      out.push(`${ind}val ${n}: ${this.t.type(p.initializer ? base(pt) : pt)} = ${value}`);
      return;
    }
    this.pattern(p.name, raw, pt, out, ind, ctx, false);
  }

  /** `const { a, b = 1 } = x` / `const [a, b] = list`. */
  pattern(name, value, vt, out, ind, ctx, mutable) {
    const kw = mutable ? "var" : "val";
    if (ts.isIdentifier(name)) {
      const t = this.typeOfNode(name);
      out.push(`${ind}${kw} ${this.nameFor(this.symbolOf(name), name.text)}: ${this.t.type(t)} = ${value}`);
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      const b = base(vt);
      if (b.k !== "obj" && b.k !== "env") {
        this.fail(name, "destructuring object hanya untuk object bertipe");
        return;
      }
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
          v = `(${v} ?: ${this.expr(el.initializer, base(ft), ctx).code})`;
          ft = base(ft);
        }
        if (ts.isIdentifier(el.name)) {
          out.push(`${ind}${kw} ${this.nameFor(this.symbolOf(el.name), el.name.text)}: ${this.t.type(ft)} = ${v}`);
        } else {
          const t2 = this.tmp("p");
          out.push(`${ind}val ${t2}: ${this.t.type(ft)} = ${v}`);
          this.pattern(el.name, t2, ft, out, ind, ctx, mutable);
        }
      }
      return;
    }
    // array pattern
    const b = base(vt);
    if (b.k !== "list") {
      this.fail(name, "destructuring array hanya untuk array bertipe");
      return;
    }
    name.elements.forEach((el, i) => {
      if (ts.isOmittedExpression(el)) return;
      if (el.dotDotDotToken) {
        out.push(`${ind}${kw} ${this.nameFor(this.symbolOf(el.name), el.name.text)}: ${this.t.type(b)} = ${value}.drop(${i})`);
        return;
      }
      let v = `${value}.getOrNull(${i})`;
      let t = opt(b.t);
      if (el.initializer) {
        v = `(${v} ?: ${this.expr(el.initializer, b.t, ctx).code})`;
        t = b.t;
      } else {
        v = `${value}[${i}]`;
        t = b.t;
      }
      if (ts.isIdentifier(el.name)) out.push(`${ind}${kw} ${this.nameFor(this.symbolOf(el.name), el.name.text)}: ${this.t.type(t)} = ${v}`);
      else {
        const t2 = this.tmp("p");
        out.push(`${ind}val ${t2}: ${this.t.type(t)} = ${v}`);
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
      const e = this.expr(fn.body, ctx.ret, ctx);
      out.push(`${ind}return ${this.coerce(e, ctx.ret, fn.body)}`);
      return;
    }
    this.block(fn.body.statements, out, ind, ctx);
    const last = fn.body.statements.at(-1);
    if (ctx.ret.k !== "void" && !(last && (ts.isReturnStatement(last) || ts.isThrowStatement(last)))) {
      out.push(`${ind}return ${ctx.ret.k === "el" || isOpt(ctx.ret) ? "null" : this.fail(fn, "fungsi harus selalu mengembalikan nilai").code}`);
    }
  }

  // --- pernyataan ---

  block(statements, out, ind, ctx) {
    // function declaration di-hoist seperti di JS: ditulis lebih dulu.
    for (const st of statements) if (ts.isFunctionDeclaration(st) && st.name) this.nameFor(this.symbolOf(st.name), st.name.text);
    for (const st of statements) if (ts.isFunctionDeclaration(st)) this.statement(st, out, ind, ctx);
    for (const st of statements) if (!ts.isFunctionDeclaration(st)) this.statement(st, out, ind, ctx);
  }

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
          out.push(`${ind}return${ctx.ret.k === "void" ? "" : " null"}`);
          return;
        }
        const e = this.expr(st.expression, ctx.ret, ctx);
        if (ctx.ret.k === "void") out.push(`${ind}${e.code}`, `${ind}return`);
        else out.push(`${ind}return ${this.coerce(e, ctx.ret, st.expression)}`);
        return;
      }
      case K.IfStatement: {
        out.push(`${ind}if (${this.cond(st.expression, ctx)}) {`);
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
        out.push(`${ind}run {`);
        this.block(st.statements, out, ind + "    ", ctx);
        out.push(`${ind}}`);
        return;
      case K.ForOfStatement: {
        const src = this.expr(st.expression, null, ctx);
        if (base(src.type).k !== "list") return void this.fail(st.expression, "for...of hanya untuk array bertipe");
        const d = st.initializer.declarations?.[0];
        if (!d) return void this.fail(st, "for...of butuh deklarasi variabel");
        const it = ts.isIdentifier(d.name) ? this.nameFor(this.symbolOf(d.name), d.name.text) : this.tmp("it");
        out.push(`${ind}for (${it} in ${src.code}) {`);
        if (!ts.isIdentifier(d.name)) this.pattern(d.name, it, base(src.type).t, out, ind + "    ", ctx, false);
        this.loopBody(st.statement, out, ind + "    ", ctx);
        out.push(`${ind}}`);
        return;
      }
      case K.ForStatement: {
        out.push(`${ind}run {`);
        const ind2 = ind + "    ";
        if (st.initializer) {
          if (ts.isVariableDeclarationList(st.initializer)) for (const d of st.initializer.declarations) this.varDecl(d, true, out, ind2, ctx);
          else out.push(`${ind2}${this.exprStatement(st.initializer, ctx)}`);
        }
        const update = st.incrementor ? this.exprStatement(st.incrementor, ctx) : null;
        out.push(`${ind2}while (${st.condition ? this.cond(st.condition, ctx) : "true"}) {`);
        const loopCtx = { ...ctx, update };
        this.loopBody(st.statement, out, ind2 + "    ", loopCtx);
        if (update) out.push(`${ind2}    ${update}`);
        out.push(`${ind2}}`, `${ind}}`);
        return;
      }
      case K.WhileStatement:
        out.push(`${ind}while (${this.cond(st.expression, ctx)}) {`);
        this.loopBody(st.statement, out, ind + "    ", { ...ctx, update: null });
        out.push(`${ind}}`);
        return;
      case K.DoStatement:
        out.push(`${ind}do {`);
        this.loopBody(st.statement, out, ind + "    ", { ...ctx, update: null });
        out.push(`${ind}} while (${this.cond(st.expression, ctx)})`);
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
      case K.ThrowStatement: {
        const e = this.expr(st.expression, null, ctx);
        out.push(`${ind}throw XPStd.error(${e.code})`);
        return;
      }
      default:
        this.fail(st, `pernyataan ${K[st.kind]} belum didukung di mode typed`);
    }
  }

  nested(st, out, ind, ctx) {
    this.block(ts.isBlock(st) ? st.statements : [st], out, ind, ctx);
  }

  loopBody(st, out, ind, ctx) {
    this.nested(st, out, ind, { ...ctx, inLoop: true });
  }

  switchStatement(st, out, ind, ctx) {
    const d = this.expr(st.expression, null, ctx);
    const tmp = this.tmp("s");
    out.push(`${ind}val ${tmp} = ${d.code}`);
    out.push(`${ind}when {`);
    let pending = [];
    for (const c of st.caseBlock.clauses) {
      if (ts.isCaseClause(c)) pending.push(this.equals({ code: tmp, type: d.type }, this.expr(c.expression, d.type, ctx), c));
      else pending.push(null);
      if (!c.statements.length) continue;
      const stmts = [...c.statements];
      const last = stmts.at(-1);
      if (last && ts.isBreakStatement(last)) stmts.pop();
      else if (!(last && (ts.isReturnStatement(last) || ts.isThrowStatement(last)))) this.fail(c, "case tanpa break (fallthrough) belum didukung di mode typed");
      const head = pending.includes(null) ? "else" : pending.join(" || ");
      out.push(`${ind}    ${head} -> {`);
      this.block(stmts, out, ind + "        ", ctx);
      out.push(`${ind}    }`);
      pending = [];
    }
    out.push(`${ind}}`);
  }

  varDecl(d, mutable, out, ind, ctx) {
    const init = d.initializer;
    // const [x, setX] = useState(...)
    if (init && ts.isCallExpression(init) && this.runtimeName(init.expression) === "useState") {
      if (!ts.isArrayBindingPattern(d.name)) return void this.fail(d, "hasil useState harus di-destructure: const [x, setX] = useState(...)");
      const stateType = this.mapType(this.checker.getTypeAtLocation(d.name.elements[0]), d);
      const arg = init.arguments[0];
      let initCode = arg ? this.expr(arg, stateType, ctx) : { code: "null", type: T.void };
      if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) initCode = { code: `${this.call0(arg, stateType, ctx)}`, type: stateType };
      const [a, b] = d.name.elements;
      const names = [a, b].map((e) => (e && !ts.isOmittedExpression(e) ? this.nameFor(this.symbolOf(e.name), e.name.text) : "_"));
      this.requireHooks(init, ctx);
      out.push(`${ind}val (${names[0]}, ${names[1]}) = h.state<${this.t.type(stateType)}> { ${this.coerce(initCode, stateType, arg ?? init)} }`);
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
      out.push(`${ind}val ${t}: ${this.t.type(e.type)} = ${e.code}`);
      this.pattern(d.name, t, e.type, out, ind, ctx, mutable);
      return;
    }
    const name = this.nameFor(this.symbolOf(d.name), d.name.text);
    let type = this.typeOfNode(d.name);
    if (!init) {
      out.push(`${ind}var ${name}: ${this.t.type(opt(type))} = null`);
      return;
    }
    const e = this.expr(init, type, ctx);
    if (e.type.k === "setter" || e.type.k === "ref") type = e.type;
    out.push(`${ind}${mutable ? "var" : "val"} ${name}: ${this.t.type(type)} = ${this.coerce(e, type, init)}`);
  }

  /** Fungsi lokal: `fun name(...)` supaya bisa rekursif dan memakai `return` biasa. */
  localFunction(fn, nameNode, ind, ctx) {
    const sym = this.symbolOf(nameNode);
    const name = this.nameFor(sym, nameNode.text);
    const { params, pre } = this.fnParams(fn, ind + "    ", ctx);
    const body = [...pre];
    this.functionBody(fn, body, ind + "    ", { ...ctx, inLoop: false, update: null });
    return [`${ind}fun ${name}(${params.join(", ")}): ${this.t.type(ctx.ret)} {`, ...body, `${ind}}`];
  }

  fnParams(fn, ind, ctx) {
    const params = [];
    const pre = [];
    fn.parameters.forEach((p, i) => {
      if (p.dotDotDotToken) this.fail(p, "parameter rest belum didukung di mode typed");
      const pt = this.typeOfNode(p.name);
      if (ts.isIdentifier(p.name) && !p.initializer) {
        params.push(`${this.nameFor(this.symbolOf(p.name), p.name.text)}: ${this.t.type(p.questionToken ? opt(pt) : pt)}`);
      } else {
        const raw = `a${i}_${this.counter++}`;
        params.push(`${raw}: ${this.t.type(p.initializer ? opt(pt) : pt)}`);
        this.bindParam(p, raw, p.initializer ? opt(pt) : pt, pre, ind, ctx);
      }
    });
    return { params, pre };
  }

  requireHooks(node, ctx) {
    if (!ctx.hooks) this.fail(node, "hooks hanya boleh dipanggil di dalam komponen atau custom hook (useXxx)");
  }

  // --- ekspresi ---

  /** Ubah nilai ke tipe tujuan kalau perlu (setter → fungsi, Double → teks, dll.). */
  coerce(e, want, node) {
    if (!want) return e.code;
    const wb = base(want);
    if (e.type.k === "setter" && wb.k === "fn") {
      const v = this.tmp("v");
      return `{ ${v}: ${this.t.type(e.type.t)} -> ${e.code}(${v}) }`;
    }
    if (wb.k === "any" || wb.k === "el") {
      if (e.type.k === "obj" || (e.type.k === "opt" && e.type.t.k === "obj")) return e.code;
      return e.code;
    }
    return e.code;
  }

  call0(fn, ret, ctx) {
    // (() => expr)() → panggil lambda langsung
    return `${this.lambda(fn, ctx, ret).code}()`;
  }

  exprStatement(e, ctx) {
    const K = ts.SyntaxKind;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === K.EqualsToken) return this.assign(e.left, this.expr(e.right, this.typeOfNode(e.left), ctx).code, ctx);
      const compound = COMPOUND[op];
      if (compound) return this.assign(e.left, this.binary(e, compound, ctx).code, ctx);
      if (op === K.AmpersandAmpersandToken) return `if (${this.cond(e.left, ctx)}) { ${this.exprStatement(e.right, ctx)} }`;
      if (op === K.BarBarToken) return `if (!(${this.cond(e.left, ctx)})) { ${this.exprStatement(e.right, ctx)} }`;
      if (op === K.CommaToken) return `${this.exprStatement(e.left, ctx)}; ${this.exprStatement(e.right, ctx)}`;
    }
    if ((ts.isPrefixUnaryExpression(e) || ts.isPostfixUnaryExpression(e)) && (e.operator === K.PlusPlusToken || e.operator === K.MinusMinusToken)) {
      const t = this.expr(e.operand, null, ctx);
      if (t.type.k !== "num") return this.fail(e, "++/-- hanya untuk number").code;
      return this.assign(e.operand, `${t.code} ${e.operator === K.PlusPlusToken ? "+" : "-"} 1.0`, ctx);
    }
    if (ts.isConditionalExpression(e)) {
      return `if (${this.cond(e.condition, ctx)}) { ${this.exprStatement(e.whenTrue, ctx)} } else { ${this.exprStatement(e.whenFalse, ctx)} }`;
    }
    const v = this.expr(e, null, ctx);
    if (ts.isCallExpression(e) && (v.type.k === "void" || v.type.k === "any")) return v.code;
    return `${v.code}`;
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
        return `${obj.code}${isOpt(obj.type) ? "!!" : ""}.${f.id} = ${value}`;
      }
    }
    return this.fail(target, "target assignment ini belum didukung di mode typed").code;
  }

  /** Kondisi if/while/ternary → Boolean Kotlin. */
  cond(e, ctx) {
    const v = this.expr(e, T.bool, ctx);
    return this.truthy(v);
  }

  truthy(v) {
    const t = v.type;
    if (t.k === "bool") return v.code;
    if (t.k === "opt" && t.t.k === "bool") return `(${v.code} == true)`;
    if (t.k === "num" || t.k === "str" || (t.k === "opt" && (t.t.k === "num" || t.t.k === "str")) || t.k === "any" || t.k === "el") return `XPStd.truthy(${v.code})`;
    if (t.k === "opt") return `(${v.code} != null)`;
    return "true";
  }

  expr(e, want, ctx) {
    const K = ts.SyntaxKind;
    switch (e.kind) {
      case K.NumericLiteral:
        return { code: kotlinNum(Number(e.text)), type: T.num };
      case K.StringLiteral:
      case K.NoSubstitutionTemplateLiteral:
        return { code: kotlinString(e.text), type: T.str };
      case K.TrueKeyword:
        return { code: "true", type: T.bool };
      case K.FalseKeyword:
        return { code: "false", type: T.bool };
      case K.NullKeyword:
        return { code: "null", type: T.void };
      case K.ParenthesizedExpression: {
        const inner = this.expr(e.expression, want, ctx);
        return { code: `(${inner.code})`, type: inner.type };
      }
      case K.AsExpression:
      case K.NonNullExpression:
      case K.SatisfiesExpression:
      case K.TypeAssertionExpression: {
        const inner = this.expr(e.expression, want, ctx);
        if (e.kind === K.NonNullExpression && isOpt(inner.type) && inner.type.k !== "any") return { code: `${inner.code}!!`, type: base(inner.type) };
        if (e.kind === K.AsExpression || e.kind === K.TypeAssertionExpression) {
          const t = this.typeOfNode(e);
          if (!same(t, inner.type) && !(inner.type.k === "void")) {
            if (e.type.kind === K.TypeReference && e.type.typeName.getText() === "const") return inner;
            return this.fail(e, "`as` yang mengubah tipe belum didukung di mode typed");
          }
        }
        return inner;
      }
      case K.Identifier:
        return this.ident(e, ctx);
      case K.TemplateExpression: {
        const parts = [kotlinString(e.head.text)];
        for (const span of e.templateSpans) {
          parts.push(this.toStr(this.expr(span.expression, null, ctx)));
          if (span.literal.text) parts.push(kotlinString(span.literal.text));
        }
        return { code: `(${parts.join(" + ")})`, type: T.str };
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
        const a = this.expr(e.whenTrue, t, ctx);
        const b = this.expr(e.whenFalse, t, ctx);
        return { code: `(if (${this.cond(e.condition, ctx)}) ${this.coerce(a, t, e)} else ${this.coerce(b, t, e)})`, type: t };
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
        return { code: `XPStd.regex(${kotlinString(text.slice(1, end))}, ${kotlinString(text.slice(end + 1))})`, type: T.regex };
      }
      case K.TypeOfExpression:
        return this.fail(e, "typeof belum didukung di mode typed");
      default:
        return this.fail(e, `ekspresi ${K[e.kind]} belum didukung di mode typed`);
    }
  }

  ident(e, ctx) {
    if (e.text === "undefined") return { code: "null", type: T.void };
    if (e.text === "NaN") return { code: "Double.NaN", type: T.num };
    if (e.text === "Infinity") return { code: "Double.POSITIVE_INFINITY", type: T.num };
    const sym = this.symbolOf(e);
    if (sym && this.names.has(sym)) {
      const decl = sym.valueDeclaration;
      // setter dari useState
      if (decl && ts.isBindingElement(decl) && ts.isArrayBindingPattern(decl.parent) && decl.parent.elements.indexOf(decl) === 1) {
        const call = decl.parent.parent.initializer;
        if (call && ts.isCallExpression(call) && this.runtimeName(call.expression) === "useState") {
          return { code: this.names.get(sym), type: { k: "setter", t: this.mapType(this.checker.getTypeAtLocation(decl.parent.elements[0]), e) } };
        }
      }
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isCallExpression(decl.initializer) && this.runtimeName(decl.initializer.expression) === "useRef") {
        const t = this.mapType(this.checker.getTypeOfSymbolAtLocation(this.checker.getPropertyOfType(this.checker.getTypeAtLocation(e), "current"), e), e);
        return { code: this.names.get(sym), type: { k: "ref", t } };
      }
      const type = this.typeOfNode(e);
      // TypeScript mempersempit tipe (`if (x) ...x...`), variabel di kode hasil tetap bertipe deklarasinya.
      const declName = decl && (ts.isVariableDeclaration(decl) || ts.isParameter(decl) || ts.isBindingElement(decl)) && ts.isIdentifier(decl.name) ? decl.name : null;
      if (declName && declName !== e) {
        const declared = this.typeOfNode(declName);
        if (isOpt(declared) && declared.k !== "any" && !isOpt(type) && same(base(declared), type)) return { code: `${this.names.get(sym)}${this.t.bang}`, type };
      }
      return { code: this.names.get(sym), type };
    }
    if (sym && this.components.has(sym)) return this.fail(e, "komponen sebagai nilai belum didukung; pakai sebagai JSX");
    return this.fail(e, `'${e.text}' belum didukung di mode typed`);
  }

  toStr(v) {
    const b = v.type;
    if (b.k === "str") return v.code;
    return `XPStd.str(${v.code})`;
  }

  arrayLiteral(e, want, ctx) {
    let t = this.typeOfNode(e);
    if (want && base(want).k === "list") t = base(want);
    if (t.k !== "list") return this.fail(e, "array harus punya tipe elemen yang jelas");
    if (!e.elements.length) return { code: `emptyList<${this.t.type(t.t)}>()`, type: t };
    if (e.elements.some((x) => ts.isSpreadElement(x))) {
      const parts = e.elements.map((x) => (ts.isSpreadElement(x) ? this.expr(x.expression, t, ctx).code : `listOf(${this.coerce(this.expr(x, t.t, ctx), t.t, x)})`));
      return { code: `(${parts.join(" + ")})`, type: t };
    }
    return { code: `listOf<${this.t.type(t.t)}>(${e.elements.map((x) => this.coerce(this.expr(x, t.t, ctx), t.t, x)).join(", ")})`, type: t };
  }

  objectLiteral(e, want, ctx) {
    let t = want && base(want).k !== "any" ? base(want) : this.mapType(this.checker.getContextualType(e) ?? this.checker.getTypeAtLocation(e), e);
    if (t.k === "opt") t = t.t;
    if (t.k === "map") return this.mapLiteral(e, t, ctx);
    if (t.k !== "obj") t = this.typeOfNode(e);
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
      else if (ts.isShorthandPropertyAssignment(p)) values.set(key, this.ident(p.name, ctx).code);
      else if (ts.isMethodDeclaration(p)) values.set(key, this.lambda(p, ctx, null, field.t).code);
      else return this.fail(p, "properti object ini belum didukung");
    }
    const args = t.cls.fields.map((f) => (values.has(f.name) ? values.get(f.name) : isOpt(f.t) ? "null" : this.fail(e, `properti '${f.name}' wajib diisi`).code));
    return { code: `${t.cls.name}(${args.join(", ")})`, type: t };
  }

  /** Style dan object untuk renderer: map. Map yang isinya konstanta diangkat ke level object. */
  mapLiteral(e, t, ctx) {
    const parts = [];
    let pending = [];
    let constant = true;
    const flush = () => {
      if (pending.length) parts.push(`xpMap(${pending.join(", ")})`);
      pending = [];
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
      if (!/^(-?[\d.]+(e-?\d+)?|"(?:[^"\\]|\\.)*"|true|false|null|xpMap\(.*\))$/.test(v.code)) constant = false;
      pending.push(`${kotlinString(key)} to ${this.hostValue(v)}`);
    }
    flush();
    if (!parts.length) return { code: "emptyMap<String, Any?>()", type: t };
    const code = parts.length === 1 ? parts[0] : `xpMerge(${parts.join(", ")})`;
    if (constant && ctx.scope !== "module") return { code: this.hoist(code), type: t };
    return { code, type: t };
  }

  hoist(code) {
    if (this.hoistedByCode.has(code)) return this.hoistedByCode.get(code);
    const name = `S${this.hoisted.length + 1}`;
    this.hoisted.push(`    private val ${name}: Map<String, Any?> = ${code}`);
    this.hoistedByCode.set(code, name);
    return name;
  }

  /** Nilai yang dikirim ke renderer: class → map (seperti JSON di JS). */
  hostValue(v) {
    const b = base(v.type);
    if (b.k === "obj") return `${v.code}${isOpt(v.type) ? "?" : ""}.toHost()`;
    if (b.k === "list" && (base(b.t).k === "obj")) return `${v.code}${isOpt(v.type) ? "?" : ""}.map { it${isOpt(b.t) ? "?" : ""}.toHost() }`;
    return v.code;
  }

  lambda(fn, ctx, retOverride, want) {
    const sig = this.checker.getSignatureFromDeclaration(fn);
    let ret = retOverride ?? this.mapType(sig.getReturnType(), fn);
    const wantFn = want && base(want).k === "fn" ? base(want) : null;
    if (wantFn && wantFn.ret.k === "void") ret = T.void;
    const inner = { ...ctx, ret, inLoop: false, update: null };
    const { params, pre } = this.fnParams(fn, "        ", inner);
    const body = [...pre];
    this.functionBody(fn, body, "        ", inner);
    const type = { k: "fn", params: fn.parameters.map((p) => this.typeOfNode(p.name)), ret };
    return { code: `fun(${params.join(", ")}): ${this.t.type(ret)} {\n${body.join("\n")}\n    }`, type };
  }

  property(e, ctx) {
    const name = e.name.text;
    const rt = this.runtimeName(e.expression);
    // Math.PI, Number.MAX_SAFE_INTEGER
    if (ts.isIdentifier(e.expression) && !this.names.has(this.symbolOf(e.expression))) {
      const g = e.expression.text;
      if (g === "Math" && name === "PI") return { code: "Math.PI", type: T.num };
      if (g === "Math" && name === "E") return { code: "Math.E", type: T.num };
      if (g === "Number" && name === "MAX_SAFE_INTEGER") return { code: "9007199254740991.0", type: T.num };
      if (g === "Number" && name === "MIN_SAFE_INTEGER") return { code: "-9007199254740991.0", type: T.num };
      if (g === "Number" && name === "EPSILON") return { code: "Math.ulp(1.0)", type: T.num };
      if (rt == null && !this.names.has(this.symbolOf(e.expression))) {
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
    const wrap = (code, t) => ({ code, type: optional || (isOpt(obj.type) && optional) ? opt(t) : t });
    if (name === "length" && (b.k === "str" || b.k === "list")) {
      return wrap(`${obj.code}${q}${b.k === "str" ? "length" : "size"}${optional ? "?" : ""}.toDouble()`, T.num);
    }
    if (b.k === "obj") {
      const f = b.cls.fields.find((x) => x.name === name);
      if (!f) return this.fail(e, `properti '${name}' tidak ada`);
      if (isOpt(obj.type) && !optional) return this.fail(e, "akses properti dari nilai yang bisa null; pakai ?.");
      return wrap(`${obj.code}${q}${f.id}`, f.t);
    }
    if (b.k === "env" && (name === "width" || name === "height" || name === "dark")) return wrap(`${obj.code}${q}${name}`, name === "dark" ? T.bool : T.num);
    if (b.k === "ref" && name === "current") return wrap(`${obj.code}${q}current`, b.t);
    if (b.k === "map") return wrap(`${obj.code}${optional ? "?" : ""}[${kotlinString(name)}]`, opt(b.t));
    return this.fail(e, `properti '${name}' pada ${b.k} belum didukung di mode typed`);
  }

  element(e, ctx) {
    const obj = this.expr(e.expression, null, ctx);
    const b = base(obj.type);
    const idx = this.expr(e.argumentExpression, null, ctx);
    if (b.k === "list" && idx.type.k === "num") {
      if (e.questionDotToken) return { code: `${obj.code}?.getOrNull(${idx.code}.toInt())`, type: opt(b.t) };
      return { code: `${obj.code}[${idx.code}.toInt()]`, type: b.t };
    }
    if (b.k === "map" && idx.type.k === "str") return { code: `${obj.code}${e.questionDotToken ? "?" : ""}[${idx.code}]`, type: opt(b.t) };
    if (b.k === "str" && idx.type.k === "num") return { code: `XPStd.charAt(${obj.code}, ${idx.code})`, type: T.str };
    return this.fail(e, "akses indeks ini belum didukung di mode typed");
  }

  args(call, ctx, types) {
    return call.arguments.map((a, i) => {
      if (ts.isSpreadElement(a)) return this.fail(a, "spread argumen belum didukung di mode typed").code;
      const want = types?.[i];
      return this.coerce(this.expr(a, want, ctx), want, a);
    });
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
      if (a && (ts.isArrowFunction(a) || ts.isFunctionExpression(a))) {
        const l = this.lambda(a, ctx, ft.t);
        return { code: `${f.code}.update(${l.code})`, type: T.void };
      }
      return { code: `${f.code}(${a ? this.coerce(this.expr(a, ft.t, ctx), ft.t, a) : "null"})`, type: T.void };
    }
    if (ft.k !== "fn") return this.fail(e, "yang dipanggil bukan fungsi bertipe");
    const sym = this.symbolOf(callee);
    const hook = sym && this.hookFns.has(sym);
    const args = this.args(e, ctx, ft.params);
    if (hook) {
      this.requireHooks(e, ctx);
      args.unshift("h");
    }
    const q = e.questionDotToken || isOpt(f.type) ? "?.invoke" : "";
    return { code: `${f.code}${q}(${args.join(", ")})`, type: q ? opt(ft.ret) : ft.ret };
  }

  hookCall(name, e, ctx) {
    this.requireHooks(e, ctx);
    const a = e.arguments;
    const deps = (node) => {
      if (!node) return "null";
      if (!ts.isArrayLiteralExpression(node)) return this.fail(node, "deps hook harus array literal").code;
      return `listOf<Any?>(${node.elements.map((x) => this.expr(x, null, ctx).code).join(", ")})`;
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
          if (!last || !ts.isReturnStatement(last)) body.push("            return null");
        } else {
          body.push(`            ${this.exprStatement(fn.body, inner)}`, "            return null");
        }
        return { code: `h.effect(${deps(a[1])}, fun(): (() -> Unit)? {\n${body.join("\n")}\n        })`, type: T.void };
      }
      case "useMemo": {
        const t = this.typeOfNode(e);
        return { code: `h.memo(${deps(a[1])}) ${this.call0Body(a[0], t, ctx)}`, type: t };
      }
      case "useCallback": {
        const t = this.typeOfNode(e);
        const fn = this.expr(a[0], t, ctx);
        return { code: `h.memo(${deps(a[1])}) { ${fn.code} }`, type: fn.type };
      }
      case "useRef": {
        const t = this.mapType(this.checker.getTypeOfSymbolAtLocation(this.checker.getPropertyOfType(this.checker.getTypeAtLocation(e), "current"), e), e);
        const init = a[0] ? this.expr(a[0], t, ctx).code : "null";
        return { code: `h.ref<${this.t.type(t)}> { ${init} }`, type: { k: "ref", t } };
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
    if (!ts.isBlock(fn.body)) return `{ ${this.coerce(this.expr(fn.body, ret, ctx), ret, fn.body)} }`;
    return `{ ${this.lambda(fn, ctx, ret).code}() }`;
  }

  globalCall(name, e, ctx) {
    const a = e.arguments;
    const one = (t) => (a[0] ? this.expr(a[0], t, ctx) : { code: "null", type: T.void });
    switch (name) {
      case "String":
        return { code: this.toStr(one(null)), type: T.str };
      case "Number":
        return { code: `XPStd.num(${one(null).code})`, type: T.num };
      case "Boolean":
        return { code: this.truthy(one(null)), type: T.bool };
      case "parseInt":
        return { code: `XPStd.parseInt(${one(T.str).code}${a[1] ? `, ${this.expr(a[1], T.num, ctx).code}` : ""})`, type: T.num };
      case "parseFloat":
        return { code: `XPStd.parseFloat(${one(T.str).code})`, type: T.num };
      case "isNaN":
        return { code: `XPStd.num(${one(null).code}).isNaN()`, type: T.bool };
      case "isFinite":
        return { code: `XPStd.num(${one(null).code}).isFinite()`, type: T.bool };
    }
    if (TIMERS.has(name)) {
      this.requireHooks(e, ctx);
      if (name.startsWith("clear")) return { code: `h.${name}(${one(T.num).code})`, type: T.void };
      const fn = a[0];
      const ms = a[1] ? this.expr(a[1], T.num, ctx).code : "0.0";
      if (!fn) return this.fail(e, `${name} butuh fungsi`);
      const l = this.lambda(fn, ctx, T.void);
      return { code: `h.${name}(${ms}, ${l.code})`, type: T.num };
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
        case "floor": return num("Math.floor");
        case "ceil": return num("Math.ceil");
        case "abs": return num("Math.abs");
        case "sqrt": return num("Math.sqrt");
        case "pow": return num("Math.pow");
        case "trunc": return num("XPStd.trunc");
        case "sign": return num("XPStd.sign");
        case "min": return n === 0 ? { code: "Double.POSITIVE_INFINITY", type: T.num } : num("XPStd.min");
        case "max": return n === 0 ? { code: "Double.NEGATIVE_INFINITY", type: T.num } : num("XPStd.max");
        case "random": return { code: "Math.random()", type: T.num };
        case "log": return num("Math.log");
        case "exp": return num("Math.exp");
        case "sin": return num("Math.sin");
        case "cos": return num("Math.cos");
        case "atan2": return num("Math.atan2");
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
    if (obj === "console") return { code: `XPStd.log(${kotlinString(name)}, ${e.arguments.map((x) => this.hostValue(this.expr(x, null, ctx))).join(", ")})`, type: T.void };
    if (obj === "Object" && (name === "keys" || name === "values" || name === "entries")) {
      const v = this.expr(e.arguments[0], null, ctx);
      const b = base(v.type);
      if (b.k !== "map") return this.fail(e, `Object.${name} hanya untuk Record di mode typed`);
      if (name === "keys") return { code: `${v.code}.keys.toList()`, type: { k: "list", t: T.str } };
      if (name === "values") return { code: `${v.code}.values.toList()`, type: { k: "list", t: b.t } };
      return this.fail(e, "Object.entries belum didukung di mode typed");
    }
    if (obj === "Array" && name === "isArray") return { code: `(${this.expr(e.arguments[0], null, ctx).code} is List<*>)`, type: T.bool };
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
      if (name === "toFixed") return wrapOpt({ code: `XPStd.toFixed(${recv.code}, ${a[0] ? this.expr(a[0], T.num, ctx).code : "0.0"})`, type: T.str });
      if (name === "toString") return wrapOpt({ code: a[0] ? `XPStd.toString(${recv.code}, ${this.expr(a[0], T.num, ctx).code})` : `XPStd.str(${recv.code})`, type: T.str });
    }
    if (b.k === "list") return wrapOpt(this.listMethod(recv, b, q, name, e, want, ctx));
    if (b.k === "regex" && name === "test") return { code: `XPStd.test(${recv.code}, ${this.expr(a[0], T.str, ctx).code})`, type: T.bool };
    if (b.k === "fn" && name === "call") return this.fail(e, ".call belum didukung di mode typed");
    return this.fail(e, `method '${name}' pada ${b.k} belum didukung di mode typed`);
  }

  stringMethod(recv, q, name, e, ctx) {
    const a = e.arguments;
    const arg = (i, t) => (a[i] ? this.expr(a[i], t, ctx).code : "null");
    const s = recv.code;
    switch (name) {
      case "toUpperCase": case "toLocaleUpperCase": return { code: `${s}${q}uppercase()`, type: T.str };
      case "toLowerCase": case "toLocaleLowerCase": return { code: `${s}${q}lowercase()`, type: T.str };
      case "trim": return { code: `XPStd.trim(${s})`, type: T.str };
      case "includes": return { code: `${s}${q}contains(${arg(0, T.str)})`, type: T.bool };
      case "startsWith": return { code: `${s}${q}startsWith(${arg(0, T.str)})`, type: T.bool };
      case "endsWith": return { code: `${s}${q}endsWith(${arg(0, T.str)})`, type: T.bool };
      case "indexOf": return { code: `${s}${q}indexOf(${arg(0, T.str)}).toDouble()`, type: T.num };
      case "toString": return { code: s, type: T.str };
      case "repeat": return { code: `${s}${q}repeat(${arg(0, T.num)}.toInt())`, type: T.str };
      case "split":
        if (a[0] && this.expr(a[0], null, ctx).type.k === "regex") break;
        return { code: `XPStd.split(${s}, ${arg(0, T.str)})`, type: { k: "list", t: T.str } };
    }
    // Sisanya lewat implementasi JS yang sama dengan mode dinamis, supaya perilakunya persis.
    const ret = this.mapType(this.checker.getTypeAtLocation(e), e);
    const args = a.map((x) => {
      const v = this.expr(x, null, ctx);
      if (base(v.type).k === "fn") return this.fail(x, `callback di string.${name} belum didukung di mode typed`).code;
      return this.hostValue(v);
    });
    const raw = `XPStd.method(${s}, ${kotlinString(name)}${args.length ? ", " + args.join(", ") : ""})`;
    return { code: this.fromDynamic(raw, ret), type: ret };
  }

  /** Nilai dari helper dinamis → tipe Kotlin. */
  fromDynamic(code, t) {
    switch (t.k) {
      case "str": return `(${code} as String)`;
      case "num": return `(${code} as Double)`;
      case "bool": return `(${code} as Boolean)`;
      case "opt":
        if (t.t.k === "list" && t.t.t.k === "str") return `XPStd.strList(${code})`;
        return `(${code} as ${this.t.type(t)})`;
      case "list":
        if (t.t.k === "str") return `XPStd.strList(${code})!!`;
        break;
    }
    return `(${code} as ${this.t.type(t)})`;
  }

  listMethod(recv, b, q, name, e, want, ctx) {
    const a = e.arguments;
    const l = recv.code;
    const elemT = b.t;
    const cb = (i, ret) => {
      const fn = a[i];
      if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        const v = this.expr(fn, null, ctx);
        return { code: v.code, arity: base(v.type).params?.length ?? 1 };
      }
      return { code: this.lambda(fn, ctx, ret).code, arity: fn.parameters.length };
    };
    const indexed = (c, f1, f2) => (c.arity >= 2 ? `${l}${q}${f2} { xpI, xpX -> (${c.code})(xpX, xpI.toDouble()) }` : `${l}${q}${f1}(${c.code})`);
    switch (name) {
      case "map": {
        const ret = this.typeOfNode(e);
        const elRet = ret.k === "list" ? ret.t : T.any;
        const c = cb(0, elRet);
        return { code: indexed(c, "map", "mapIndexed"), type: ret.k === "list" ? ret : { k: "list", t: T.any } };
      }
      case "filter": {
        const c = cb(0, T.bool);
        return { code: c.arity >= 2 ? `${l}${q}filterIndexed { xpI, xpX -> (${c.code})(xpX, xpI.toDouble()) }` : `${l}${q}filter(${c.code})`, type: b };
      }
      case "forEach": {
        const c = cb(0, T.void);
        return { code: c.arity >= 2 ? `${l}${q}forEachIndexed { xpI, xpX -> (${c.code})(xpX, xpI.toDouble()) }` : `${l}${q}forEach(${c.code})`, type: T.void };
      }
      case "find": return { code: `${l}${q}firstOrNull(${cb(0, T.bool).code})`, type: opt(elemT) };
      case "findIndex": return { code: `${l}${q}indexOfFirst(${cb(0, T.bool).code}).toDouble()`, type: T.num };
      case "some": return { code: `${l}${q}any(${cb(0, T.bool).code})`, type: T.bool };
      case "every": return { code: `${l}${q}all(${cb(0, T.bool).code})`, type: T.bool };
      case "includes": return { code: `${l}${q}contains(${this.expr(a[0], elemT, ctx).code})`, type: T.bool };
      case "indexOf": return { code: `${l}${q}indexOf(${this.expr(a[0], elemT, ctx).code}).toDouble()`, type: T.num };
      case "join": return { code: `XPStd.join(${l}, ${a[0] ? this.expr(a[0], T.str, ctx).code : '","'})`, type: T.str };
      case "slice": return { code: `XPStd.slice(${l}${a.length ? ", " + a.map((x) => this.expr(x, T.num, ctx).code).join(", ") : ""})`, type: b };
      case "concat": return { code: `(${[l, ...a.map((x) => this.expr(x, b, ctx).code)].join(" + ")})`, type: b };
      case "reverse": case "toReversed": return { code: `${l}${q}reversed()`, type: b };
      case "reduce": {
        if (!a[1]) return this.fail(e, "reduce butuh nilai awal di mode typed");
        const t = this.typeOfNode(e);
        const init = this.expr(a[1], t, ctx);
        const c = cb(0, t);
        return { code: `${l}${q}fold(${init.code}) { xpAcc, xpX -> (${c.code})(xpAcc, xpX) }`, type: t };
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
        return { code: ts.isNumericLiteral(e.operand) ? kotlinNum(-Number(e.operand.text)) : `-${v.code}`, type: T.num };
      }
      case K.PlusToken:
        return { code: `XPStd.num(${this.expr(e.operand, null, ctx).code})`, type: T.num };
      case K.TildeToken:
        return { code: `XPStd.bitNot(${this.expr(e.operand, T.num, ctx).code})`, type: T.num };
      default:
        return this.fail(e, "operator ini sebagai nilai belum didukung di mode typed");
    }
  }

  wrapCond(c) {
    return /^[\w.]+$|^\(.*\)$/.test(c) ? c : `(${c})`;
  }

  equals(a, b, node, negate = false) {
    const ta = base(a.type), tb = base(b.type);
    const nullish = a.type.k === "void" || b.type.k === "void";
    const prim = (t) => t.k === "num" || t.k === "str" || t.k === "bool";
    let code;
    if (nullish) code = `${a.code} == ${b.code}`;
    else if (prim(ta) && prim(tb)) {
      if (ta.k !== tb.k) code = "false";
      else code = `${a.code} == ${b.code}`;
    } else if (ta.k === "any" || tb.k === "any") code = `XPStd.strictEquals(${a.code}, ${b.code})`;
    else code = `${a.code} === ${b.code}`;
    if (negate) return code === "false" ? "true" : `!(${code})`;
    return code;
  }

  binaryExpr(e, want, ctx) {
    const K = ts.SyntaxKind;
    const op = e.operatorToken.kind;
    switch (op) {
      case K.EqualsEqualsEqualsToken:
      case K.EqualsEqualsToken:
        return { code: `(${this.equals(this.expr(e.left, null, ctx), this.expr(e.right, null, ctx), e)})`, type: T.bool };
      case K.ExclamationEqualsEqualsToken:
      case K.ExclamationEqualsToken:
        return { code: `(${this.equals(this.expr(e.left, null, ctx), this.expr(e.right, null, ctx), e, true)})`, type: T.bool };
      case K.LessThanToken:
      case K.GreaterThanToken:
      case K.LessThanEqualsToken:
      case K.GreaterThanEqualsToken: {
        const l = this.expr(e.left, null, ctx), r = this.expr(e.right, null, ctx);
        const sym = { [K.LessThanToken]: "<", [K.GreaterThanToken]: ">", [K.LessThanEqualsToken]: "<=", [K.GreaterThanEqualsToken]: ">=" }[op];
        if (l.type.k === "num" && r.type.k === "num") return { code: `(${l.code} ${sym} ${r.code})`, type: T.bool };
        if (l.type.k === "str" && r.type.k === "str") return { code: `(${l.code} ${sym} ${r.code})`, type: T.bool };
        return this.fail(e, "perbandingan hanya untuk dua number atau dua string");
      }
      case K.AmpersandAmpersandToken:
      case K.BarBarToken: {
        const l = this.expr(e.left, null, ctx);
        const r = this.expr(e.right, want, ctx);
        const and = op === K.AmpersandAmpersandToken;
        if (l.type.k === "bool" && r.type.k === "bool") return { code: `(${l.code} ${and ? "&&" : "||"} ${r.code})`, type: T.bool };
        if (l.type.k === "bool") return { code: and ? `(if (${l.code}) ${r.code} else false)` : `(if (${l.code}) true else ${r.code})`, type: r.type.k === "el" ? T.el : T.any };
        const t = this.tmp("v");
        const lt = this.truthy({ code: t, type: l.type });
        const type = same(l.type, r.type) ? l.type : !and && same(base(l.type), r.type) ? r.type : T.any;
        return { code: `${this.wrapCond(l.code)}.let { ${t} -> if (${lt}) ${and ? r.code : t} else ${and ? t : r.code} }`, type };
      }
      case K.QuestionQuestionToken: {
        const l = this.expr(e.left, null, ctx);
        const r = this.expr(e.right, base(l.type), ctx);
        return { code: `(${l.code} ?: ${r.code})`, type: isOpt(r.type) ? l.type : base(l.type) };
      }
      case K.CommaToken:
        return this.fail(e, "operator koma belum didukung di mode typed");
      case K.EqualsToken:
        return this.fail(e, "assignment sebagai nilai belum didukung; pakai sebagai pernyataan");
      case K.InstanceOfKeyword:
        return this.fail(e, "instanceof belum didukung di mode typed");
      case K.InKeyword:
        return this.fail(e, "operator in belum didukung di mode typed");
    }
    if (COMPOUND[op]) return this.fail(e, "assignment gabungan sebagai nilai belum didukung");
    return this.binary(e, op, ctx);
  }

  binary(e, op, ctx) {
    const K = ts.SyntaxKind;
    const l = this.expr(e.left, null, ctx), r = this.expr(e.right, null, ctx);
    if (op === K.PlusToken && (l.type.k === "str" || r.type.k === "str")) {
      return { code: `(${this.toStr(l)} + ${this.toStr(r)})`, type: T.str };
    }
    if (l.type.k !== "num" || r.type.k !== "num") return this.fail(e, `operator ${K[op]} hanya untuk number di mode typed`);
    switch (op) {
      case K.PlusToken: return { code: `(${l.code} + ${r.code})`, type: T.num };
      case K.MinusToken: return { code: `(${l.code} - ${r.code})`, type: T.num };
      case K.AsteriskToken: return { code: `(${l.code} * ${r.code})`, type: T.num };
      case K.SlashToken: return { code: `(${l.code} / ${r.code})`, type: T.num };
      case K.PercentToken: return { code: `(${l.code} % ${r.code})`, type: T.num };
      case K.AsteriskAsteriskToken: return { code: `Math.pow(${l.code}, ${r.code})`, type: T.num };
      case K.AmpersandToken: return { code: `XPStd.bitAnd(${l.code}, ${r.code})`, type: T.num };
      case K.BarToken: return { code: `XPStd.bitOr(${l.code}, ${r.code})`, type: T.num };
      case K.CaretToken: return { code: `XPStd.bitXor(${l.code}, ${r.code})`, type: T.num };
      case K.LessThanLessThanToken: return { code: `XPStd.shl(${l.code}, ${r.code})`, type: T.num };
      case K.GreaterThanGreaterThanToken: return { code: `XPStd.shr(${l.code}, ${r.code})`, type: T.num };
      case K.GreaterThanGreaterThanGreaterThanToken: return { code: `XPStd.ushr(${l.code}, ${r.code})`, type: T.num };
    }
    return this.fail(e, `operator ${K[op]} belum didukung`);
  }

  // --- JSX ---

  jsx(e, ctx) {
    if (ts.isJsxFragment(e)) return { code: this.children(e.children, ctx) ?? "null", type: T.el };
    const opening = ts.isJsxElement(e) ? e.openingElement : e;
    const tag = opening.tagName;
    const children = ts.isJsxElement(e) ? e.children : [];
    const rt = ts.isIdentifier(tag) ? this.runtimeName(tag) : null;
    if (rt === "Fragment") return { code: this.children(children, ctx) ?? "null", type: T.el };
    if (rt && PRIMITIVES.has(rt)) return this.primitive(rt, opening, children, ctx);
    const sym = ts.isIdentifier(tag) ? this.symbolOf(tag) : null;
    const compDecl = sym?.valueDeclaration;
    if (sym && compDecl && !this.isRuntimeFile(compDecl.getSourceFile())) return this.userComponent(sym, tag, opening, children, ctx);
    return this.fail(tag, `komponen '${tag.getText()}' tidak dikenal di mode typed`);
  }

  /** Children JSX → satu nilai: null, satu elemen/teks, atau listOf(...). */
  children(nodes, ctx) {
    const items = [];
    for (const c of nodes) {
      if (ts.isJsxText(c)) {
        const text = jsxText(decodeEntities(c.text));
        if (text) items.push(kotlinString(text));
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
    return items.length === 1 ? items[0] : `listOf(\n${items.join(",\n")},\n)`;
  }

  childValue(e, ctx) {
    const v = this.expr(e, T.el, ctx);
    const b = base(v.type);
    if (b.k === "obj") return this.fail(e, "object tidak bisa jadi child").code;
    if (b.k === "list" && base(b.t).k === "obj") return this.fail(e, "array object tidak bisa jadi child").code;
    return v.code;
  }

  primitive(name, opening, children, ctx) {
    const props = [];
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
        const k = valueNode ? this.expr(valueNode, null, ctx) : { code: '"true"', type: T.str };
        key = this.toStr(k);
        continue;
      }
      if (prop === "children") {
        this.fail(attr, "prop children belum didukung di mode typed; tulis sebagai isi tag");
        continue;
      }
      const declType = this.checker.getContextualType(valueNode ?? attr);
      const want = declType ? this.mapType(declType, attr) : null;
      if (want && base(want).k === "fn") {
        handlers.push(`${kotlinString(prop)} to ${this.handler(valueNode, base(want), ctx)}`);
        continue;
      }
      const v = valueNode ? this.expr(valueNode, want, ctx) : { code: "true", type: T.bool };
      props.push(`${kotlinString(prop)} to ${this.hostValue(v)}`);
    }
    const kids = this.children(children, ctx);
    const parts = [kotlinString(name)];
    if (className) parts.push(`props = XPClassName.props(CLS, h, xpProps(${props.join(", ")}), ${className})`);
    else if (props.length) parts.push(`props = xpProps(${props.join(", ")})`);
    if (handlers.length) parts.push(`handlers = mapOf(${handlers.join(", ")})`);
    if (key) parts.push(`key = ${key}`);
    if (kids) parts.push(`children = ${kids}`);
    return { code: `el(${parts.join(", ")})`, type: T.el };
  }

  /** Handler event untuk renderer: argumen dari renderer diubah ke tipe parameter fungsi. */
  handler(valueNode, fnType, ctx) {
    const cast = (t, i) => {
      const a = `a.getOrNull(${i})`;
      switch (base(t).k) {
        case "str": return isOpt(t) ? `(${a} as? String)` : `(${a} as String)`;
        case "num": return `XPStd.num(${a})`;
        case "bool": return `(${a} == true)`;
        default: return a;
      }
    };
    if (ts.isArrowFunction(valueNode) || ts.isFunctionExpression(valueNode)) {
      const inner = { ...ctx, ret: T.void, inLoop: false, update: null };
      const body = [];
      valueNode.parameters.forEach((p, i) => {
        const pt = this.typeOfNode(p.name);
        if (ts.isIdentifier(p.name)) body.push(`            val ${this.nameFor(this.symbolOf(p.name), p.name.text)}: ${this.t.type(pt)} = ${cast(pt, i)}`);
        else this.fail(p, "destructuring parameter handler belum didukung");
      });
      if (ts.isBlock(valueNode.body)) this.block(valueNode.body.statements, body, "            ", inner);
      else body.push(`            ${this.exprStatement(valueNode.body, inner)}`);
      return `{ a: List<Any?> ->\n${body.join("\n")}\n        }`;
    }
    const f = this.expr(valueNode, fnType, ctx);
    const ft = base(f.type);
    if (ft.k === "setter") return `{ a: List<Any?> -> ${f.code}(${cast(ft.t, 0)}) }`;
    if (ft.k !== "fn") return this.fail(valueNode, "handler harus fungsi").code;
    const args = ft.params.map((t, i) => cast(t, i));
    if (isOpt(f.type)) return `{ a: List<Any?> -> ${f.code}?.invoke(${args.join(", ")}) }`;
    return `{ a: List<Any?> -> ${f.code}(${args.join(", ")}) }`;
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
    let propsCode = "Unit";
    if (info.cls) {
      const args = info.cls.fields.map((f) => (values.has(f.name) ? values.get(f.name) : isOpt(f.t) ? "null" : this.fail(opening, `prop '${f.name}' wajib diisi`).code));
      propsCode = `${info.cls.name}(${args.join(", ")})`;
    }
    const p = this.tmp("p");
    return { code: `run { val ${p} = ${propsCode}; comp(${kotlinString(info.name)}, ${key ?? "null"}) { h -> ${info.name}(${p}, h) } }`, type: T.el };
  }

  pendingComponent(sym) {
    // Komponen dideklarasikan setelah dipakai: daftarkan dulu namanya, isinya dikompilasi saat giliran.
    const decl = sym.valueDeclaration;
    let fn = decl;
    if (decl && ts.isVariableDeclaration(decl)) fn = decl.initializer;
    if (!fn || !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return null;
    const name = this.nameFor(sym, sym.name);
    const p = fn.parameters[0];
    const cls = p ? this.typeOfNode(p.name).cls : null;
    const info = { name, cls };
    this.components.set(sym, info);
    return info;
  }
}

const K0 = ts.SyntaxKind;
export const COMPOUND = {
  [K0.PlusEqualsToken]: K0.PlusToken,
  [K0.MinusEqualsToken]: K0.MinusToken,
  [K0.AsteriskEqualsToken]: K0.AsteriskToken,
  [K0.SlashEqualsToken]: K0.SlashToken,
  [K0.PercentEqualsToken]: K0.PercentToken,
};

/** Class Kotlin untuk type alias / interface, dengan konversi dari/ke map (props app, renderer). */
function kotlinClass(cls, t) {
  const fields = cls.fields.map((f) => `var ${f.id}: ${t.type(f.t)}`).join(", ");
  const fromHost = (ft, v) => {
    const b = base(ft);
    const o = isOpt(ft);
    switch (b.k) {
      case "num": return o ? `XPStd.numOrNull(${v})` : `XPStd.num(${v})`;
      case "str": return o ? `(${v} as? String)` : `(${v} as? String ?: "")`;
      case "bool": return o ? `(${v} as? Boolean)` : `(${v} == true)`;
      case "obj": return o ? `${v}?.let { ${b.cls.name}.fromHost(it) }` : `${b.cls.name}.fromHost(${v})`;
      case "list": {
        const inner = fromHost(b.t, "it");
        return o ? `(${v} as? List<*>)?.map { ${inner} }` : `((${v} as? List<*>) ?: emptyList<Any?>()).map { ${inner} }`;
      }
      case "map": return `XPStd.map(${v})`;
      case "any": case "el": return v;
      default: return `(${v} as ${t.type(ft)})`;
    }
  };
  const toHost = (ft, v) => {
    const b = base(ft);
    if (b.k === "obj") return `${v}${isOpt(ft) ? "?" : ""}.toHost()`;
    if (b.k === "list" && base(b.t).k === "obj") return `${v}${isOpt(ft) ? "?" : ""}.map { ${toHost(b.t, "it")} }`;
    return v;
  };
  return [
    `    class ${cls.name}(${fields}) : XPHostValue {`,
    `        override fun toHost(): Map<String, Any?> = xpProps(${cls.fields.map((f) => `${kotlinString(f.name)} to ${toHost(f.t, f.id)}`).join(", ")})`,
    `        companion object {`,
    `            fun fromHost(v: Any?): ${cls.name} {`,
    `                val m = v as? Map<*, *> ?: emptyMap<String, Any?>()`,
    `                return ${cls.name}(${cls.fields.map((f) => fromHost(f.t, `m[${kotlinString(f.name)}]`)).join(", ")})`,
    `            }`,
    `        }`,
    `    }`,
  ];
}

/** Rapikan indentasi kode hasil: setiap baris diindentasi sesuai kedalaman kurung. */
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
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        i++;
        while (i < line.length && line[i] !== '"') i += line[i] === "\\" ? 2 : 1;
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

function compilerOptions() {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    jsx: ts.JsxEmit.ReactJSX,
    jsxImportSource: "@xp/runtime",
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    allowImportingTsExtensions: true,
    paths: { "@xp/runtime": [path.join(RUNTIME, "index.ts")], "@xp/runtime/*": [path.join(RUNTIME, "*")] },
    types: [],
  };
}

/**
 * Analisis bersama Kotlin/Swift: program TypeScript, modul, nama, dan isi modul (kode target).
 * `CompilerClass` menentukan bahasa targetnya.
 */
export function compileModules({ file, name, projectDir, classes = null, CompilerClass = Compiler, target = kotlin }) {
  const entry = path.resolve(file);
  const program = ts.createProgram([entry], compilerOptions());
  const diags = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && !d.file.fileName.includes("node_modules") && !path.resolve(d.file.fileName).startsWith(RUNTIME) && d.category === ts.DiagnosticCategory.Error);
  if (diags.length) {
    const d = diags[0];
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
    throw new TypedCompileError(`${path.relative(projectDir, d.file.fileName)}:${line + 1}:${character + 1} error TypeScript: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  }
  const c = new CompilerClass(program, entry, projectDir, target);
  c.classTable = classes;
  c.components = new Map();
  c.componentProps = new Map();
  c.hookFns = new Set();
  const mods = c.collectModules();
  // daftarkan custom hook (useXxx) supaya pemanggilnya mengirim h
  for (const sf of mods) {
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && /^use[A-Z]/.test(st.name.text)) c.hookFns.add(c.symbolOf(st.name));
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && /^use[A-Z]/.test(d.name.text)) c.hookFns.add(c.symbolOf(d.name));
    }
  }
  // nama semua deklarasi level modul didaftarkan dulu (fungsi bisa dipakai sebelum dideklarasikan)
  for (const sf of mods) {
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name) c.nameFor(c.symbolOf(st.name), st.name.text);
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) c.nameFor(c.symbolOf(d.name), d.name.text);
    }
  }
  const body = [];
  for (const sf of mods) c.module(sf, body);
  // export default
  const sf = program.getSourceFile(entry);
  let def = null;
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) def = c.symbolOf(st.name) ?? st.symbol;
    if (ts.isExportAssignment(st)) def = c.symbolOf(st.expression);
  }
  const root = def && c.components.get(def);
  if (!root) c.errors.push(`${path.relative(projectDir, entry)} export default harus komponen`);
  if (c.errors.length) throw new TypedCompileError([...new Set(c.errors)].join("\n"));
  const hash = createHash("sha256").update(mods.map((m) => m.text).join("\n")).digest("hex").slice(0, 16);
  return { c, body, root, hash, typeName: typedName(name) };
}

/**
 * Kompilasi satu komponen ke Kotlin bertipe.
 * @returns {{ code: string, typeName: string, hash: string }}
 */
export function compileTypedKotlin({ file, name, projectDir, classes = null }) {
  const { c, body, root, hash, typeName } = compileModules({ file, name, projectDir, classes });
  const classDecls = c.classOrder.flatMap((cls) => [...kotlinClass(cls, kotlin), ""]);
  const rootCall = root.cls ? `${root.name}(${root.cls.name}.fromHost(props), h)` : `${root.name}(Unit, h)`;
  const code = reindent(`// Dibuat oleh xp build dari ${kotlinString(name)} (mode typed). Jangan diubah manual.
@file:Suppress("UNUSED_PARAMETER", "UNUSED_VARIABLE", "NAME_SHADOWING", "UNUSED_ANONYMOUS_PARAMETER", "RedundantExplicitType", "UNCHECKED_CAST", "SENSELESS_COMPARISON", "UNNECESSARY_SAFE_CALL", "USELESS_ELVIS", "UNNECESSARY_NOT_NULL_ASSERTION")

package dev.xp.generated

import dev.xp.android.typed.*

object ${typeName} : XPTypedComponent {
    override val name = ${kotlinString(name)}
    override val hash = ${kotlinString(hash)}

${c.usesClasses ? `    private val CLS = XPClassName.table(${kotlinString(JSON.stringify(classes))})\n\n` : ""}${classDecls.join("\n")}${c.hoisted.join("\n")}${c.hoisted.length ? "\n\n" : ""}${body.join("\n")}
    override fun render(props: Map<String, Any?>, h: XPHooks): Any? = ${rootCall}
}
`);
  return { code, typeName, hash };
}

export function readSource(file) {
  return readFileSync(file, "utf8");
}
