// Memuat bundle web hasil `xp build` seperti loader adapter: runtime bersama dulu (komponen xp),
// lalu bundle komponen dengan `require` yang menunjuk ke modul runtime itu.
import { readFileSync } from "node:fs";

type Web = { file: string; runtime?: { file: string } };

export function evaluate(code: string, require?: (id: string) => unknown) {
  const module = { exports: {} as any };
  new Function("module", "exports", "require", code)(module, module.exports, require);
  return module.exports;
}

const runtimes = new Map<string, Record<string, unknown>>();

export function loadWeb(web: Web, dir = "dist") {
  let modules: Record<string, unknown> = {};
  if (web.runtime) {
    const f = web.runtime.file;
    if (!runtimes.has(f)) runtimes.set(f, evaluate(readFileSync(`${dir}/${f}`, "utf8")).modules);
    modules = runtimes.get(f)!;
  }
  return evaluate(readFileSync(`${dir}/${web.file}`, "utf8"), (id) => {
    if (!(id in modules)) throw new Error(`modul tidak tersedia: ${id}`);
    return modules[id];
  });
}
