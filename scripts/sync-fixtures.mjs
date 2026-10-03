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

// Manifest bertanda tangan untuk tes verifikasi signing di Kotlin dan Swift.
// Kunci dibuat baru setiap kali; hanya kunci publik dan tanda tangannya yang disimpan.
const { generateKeys, signManifest } = await import("../cli/sign.mjs");
const { createPrivateKey } = await import("node:crypto");
const { writeFile } = await import("node:fs/promises");
const manifestText = await readFile("dist/manifest.json", "utf8");
const keys = generateKeys();
const signed = JSON.stringify(
  { manifest: manifestText, signature: signManifest(manifestText, createPrivateKey(keys.privatePem)), publicKey: keys.publicKey },
  null,
  2,
);
for (const dir of Object.keys(targets)) {
  await writeFile(`${dir}/signed-manifest.json`, signed);
  console.log(`signed-manifest.json → ${dir}`);
}
