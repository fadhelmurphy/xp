// Signing manifest: ECDSA P-256 + SHA-256.
//
// manifest.json berisi sha256 setiap bundle, jadi cukup manifest yang ditandatangani.
// Tanda tangan (DER, base64) ditulis ke manifest.sig di samping manifest.json.
// Kunci publik dibagikan sebagai base64 SPKI DER: satu baris yang bisa ditempel di
// konfigurasi Next/Nuxt, Kotlin (X509EncodedKeySpec), atau Swift (CryptoKit derRepresentation).
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const SIGNATURE_FILE = "manifest.sig";

export function generateKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

/** Kunci privat dari --sign <file>, atau dari env XP_SIGNING_KEY (isi PEM, untuk CI). */
export async function loadPrivateKey(file) {
  const pem = file ? await readFile(path.resolve(file), "utf8") : process.env.XP_SIGNING_KEY;
  if (!pem) return null;
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("kunci signing harus EC P-256 (buat dengan `xp keygen`)");
  return key;
}

export const publicKeyOf = (privateKey) => createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");

export function signManifest(text, privateKey) {
  return sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "der" }).toString("base64");
}

export function verifyManifest(text, signature, publicKeyBase64) {
  const key = createPublicKey({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
  return verify("sha256", Buffer.from(text, "utf8"), { key, dsaEncoding: "der" }, Buffer.from(signature.trim(), "base64"));
}

export async function keygen(outDir) {
  const { privatePem, publicKey } = generateKeys();
  const keyFile = path.join(outDir, "xp-signing-key.pem");
  const pubFile = path.join(outDir, "xp-public-key.txt");
  await writeFile(keyFile, privatePem, { mode: 0o600, flag: "wx" });
  await writeFile(pubFile, `${publicKey}\n`);
  return { keyFile, pubFile, publicKey };
}
