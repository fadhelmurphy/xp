// Signing manifest: xp build --sign → manifest.sig, diverifikasi adapter web (WebCrypto).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
// @ts-expect-error modul .mjs tanpa tipe
import { discover, plan, runBuild } from "../cli/build.mjs";
// @ts-expect-error modul .mjs tanpa tipe
import { generateKeys, verifyManifest as verifyNode } from "../cli/sign.mjs";
import { createPrivateKey } from "node:crypto";
// @ts-expect-error modul .js tanpa tipe
import { verifyManifest as verifyWeb } from "../adapters/next/verify.js";

test("build --sign menulis manifest.sig yang bisa diverifikasi Node dan WebCrypto", async () => {
  const out = mkdtempSync(path.join(tmpdir(), "xp-sign-"));
  const { privatePem, publicKey } = generateKeys();
  const { jobs } = plan((await discover("examples")).filter((c: { name: string }) => c.name === "promo-modal"), "auto");
  await runBuild({ srcDir: "examples", outDir: out, jobs, signingKey: createPrivateKey(privatePem) });

  const text = readFileSync(path.join(out, "manifest.json"), "utf8");
  const sig = readFileSync(path.join(out, "manifest.sig"), "utf8");
  assert.ok(verifyNode(text, sig, publicKey));
  assert.equal(await verifyWeb(text, sig, publicKey), true);

  // Isi diubah → ditolak. Kunci lain → ditolak.
  assert.equal(await verifyWeb(text.replace("promo-modal", "promo-modaI"), sig, publicKey), false);
  assert.equal(await verifyWeb(text, sig, generateKeys().publicKey), false);

  // Build ulang tanpa --sign menghapus tanda tangan lama.
  await runBuild({ srcDir: "examples", outDir: out, jobs });
  assert.equal(existsSync(path.join(out, "manifest.sig")), false);
});
