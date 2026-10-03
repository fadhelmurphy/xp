// Verifikasi manifest.sig (ECDSA P-256 + SHA-256, hasil `xp build --sign`).
// Pakai WebCrypto supaya jalan di Node dan edge runtime.

const fromBase64 = (s) => Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));

// Tanda tangan ditulis dalam format DER (sama dengan Java/Android dan CryptoKit),
// WebCrypto butuh r||s mentah 64 byte.
function derToRaw(der) {
  let i = 2;
  if (der[0] !== 0x30) throw new Error("tanda tangan bukan DER");
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  const int = () => {
    if (der[i++] !== 0x02) throw new Error("tanda tangan bukan DER");
    const len = der[i++];
    let v = der.slice(i, i + len);
    i += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const raw = new Uint8Array(64);
  raw.set(int(), 0);
  raw.set(int(), 32);
  return raw;
}

const keys = new Map();

/** @param publicKey base64 SPKI DER (isi xp-public-key.txt) */
export async function verifyManifest(text, signature, publicKey) {
  let key = keys.get(publicKey);
  if (!key) {
    key = await crypto.subtle.importKey("spki", fromBase64(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    keys.set(publicKey, key);
  }
  try {
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(fromBase64(signature)), new TextEncoder().encode(text));
  } catch {
    return false;
  }
}
