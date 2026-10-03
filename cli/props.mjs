// Membaca tipe props dari default export komponen dan menuliskannya sebagai
// deklarasi TypeScript yang berdiri sendiri (tanpa import ke @xp/runtime),
// supaya app konsumen mendapat autocomplete & pengecekan props.
// Hasil yang sama nanti dipakai codegen Swift/Kotlin.
import path from "node:path";
import ts from "typescript";

export function createPropsReader(entries, runtimeDir, { jsxImportSource = "@xp/runtime" } = {}) {
  const program = ts.createProgram(entries, {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    jsxImportSource,
    baseUrl: path.dirname(runtimeDir),
    paths: {
      "@xp/runtime": [path.join(runtimeDir, "index.ts")],
      "@xp/runtime/*": [path.join(runtimeDir, "*")],
    },
  });
  const checker = program.getTypeChecker();

  /** Error tipe di komponen = build gagal, seperti tsc. */
  function diagnostics(entry) {
    const sf = program.getSourceFile(entry);
    return [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].map((d) => {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      if (!d.file) return msg;
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
      return `${path.relative(process.cwd(), d.file.fileName)}:${line + 1}:${character + 1} ${msg}`;
    });
  }

  function print(type, depth = 0) {
    if (depth > 8) return "unknown";
    const f = type.flags;
    if (f & ts.TypeFlags.Boolean) return "boolean";
    if (type.isUnion()) {
      const parts = [];
      let hasTrue = false, hasFalse = false;
      for (const t of type.types) {
        if (t.flags & ts.TypeFlags.BooleanLiteral) {
          checker.typeToString(t) === "true" ? (hasTrue = true) : (hasFalse = true);
          continue;
        }
        parts.push(print(t, depth + 1));
      }
      if (hasTrue && hasFalse) parts.push("boolean");
      else if (hasTrue) parts.push("true");
      else if (hasFalse) parts.push("false");
      return [...new Set(parts)].join(" | ");
    }
    if (
      f & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Null |
        ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
    ) {
      return checker.typeToString(type);
    }
    if (checker.isArrayType(type)) {
      const el = print(checker.getTypeArguments(type)[0], depth);
      return /[|&(]/.test(el) ? `(${el})[]` : `${el}[]`;
    }
    const sigs = type.getCallSignatures();
    if (sigs.length) {
      const s = sigs[0];
      const params = s.getParameters().map((p) => {
        const pt = checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration);
        return `${p.getName()}: ${print(pt, depth + 1)}`;
      });
      return `(${params.join(", ")}) => ${print(s.getReturnType(), depth + 1)}`;
    }
    if (f & ts.TypeFlags.Object) {
      const props = checker.getPropertiesOfType(type);
      if (!props.length) return "{}";
      const indent = "  ".repeat(depth + 1);
      const lines = props.map((p) => {
        const optional = (p.flags & ts.SymbolFlags.Optional) !== 0;
        let pt = checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? p.declarations?.[0]);
        if (optional && pt.isUnion()) {
          const rest = pt.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined));
          pt = rest.length === 1 ? rest[0] : pt;
        }
        let text = print(pt, depth + 1);
        if (optional) text = text.split(" | ").filter((x) => x !== "undefined").join(" | ");
        const doc = ts.displayPartsToString(p.getDocumentationComment(checker));
        const name = /^[A-Za-z_$][\w$]*$/.test(p.getName()) ? p.getName() : JSON.stringify(p.getName());
        return `${doc ? `${indent}/** ${doc} */\n` : ""}${indent}${name}${optional ? "?" : ""}: ${text};`;
      });
      return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
    }
    return checker.typeToString(type);
  }

  /** Mengembalikan teks tipe props, mis. "{\n  title: string;\n}". */
  function propsOf(entry) {
    const sf = program.getSourceFile(entry);
    const mod = sf && checker.getSymbolAtLocation(sf);
    const def = mod && checker.getExportsOfModule(mod).find((s) => s.getName() === "default");
    if (!def) throw new Error(`${path.basename(entry)} harus punya default export (komponen)`);
    const target = def.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(def) : def;
    const type = checker.getTypeOfSymbolAtLocation(target, target.valueDeclaration ?? sf);
    const sig = type.getCallSignatures()[0];
    if (!sig) throw new Error(`default export ${path.basename(entry)} bukan komponen (function)`);
    const param = sig.getParameters()[0];
    if (!param) return "{}";
    return print(checker.getTypeOfSymbolAtLocation(param, param.valueDeclaration));
  }

  return { propsOf, diagnostics };
}
