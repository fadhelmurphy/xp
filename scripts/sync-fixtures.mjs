// Menyalin fixture lintas platform ke tes SDK Android & iOS:
//   - fixtures/promo-modal.session.json (rekaman operasi UI dari QuickJS, dibuat oleh npm test)
//   - bundle native promo-modal dari dist/ (dibuat oleh npm run build)
import { copyFile, readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("dist/manifest.json", "utf8"));
const bundle = `dist/${manifest.components["promo-modal"].native.file}`;

const targets = {
  "adapters/android/xp-android/src/test/resources": ["fixtures/promo-modal.session.json"],
  "adapters/ios/Tests/XPKitTests/Fixtures": ["fixtures/promo-modal.session.json", bundle],
};
for (const [dir, files] of Object.entries(targets)) {
  for (const f of files) {
    const name = f.includes(".native.") ? "promo-modal.native.js" : f.split("/").pop();
    await copyFile(f, `${dir}/${name}`);
    console.log(`${f} → ${dir}/${name}`);
  }
}
