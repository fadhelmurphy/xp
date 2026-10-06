// Membuat paket adapter (.tgz) yang dipasang app contoh di examples-consumer/.
//   npm run pack:adapters
// Paket lama dihapus dulu supaya tidak ada versi ganda.
import { execSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";

for (const name of ["next", "vite", "nuxt"]) {
  const dir = path.join("adapters", name);
  for (const f of readdirSync(dir)) if (f.endsWith(".tgz")) rmSync(path.join(dir, f));
  const file = execSync("npm pack --silent", { cwd: dir, encoding: "utf8" }).trim().split("\n").pop();
  console.log(`✓ ${path.join(dir, file)}`);
}
