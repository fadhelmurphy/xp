package dev.xp.android

import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/**
 * Verifikasi manifest.sig hasil `xp build --sign`: ECDSA P-256 + SHA-256, tanda tangan DER.
 * Kunci publik: base64 SPKI DER (isi xp-public-key.txt).
 */
object XPSignature {
    fun verify(manifest: String, signatureBase64: String, publicKeyBase64: String): Boolean = try {
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(publicKeyBase64.trim())))
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(key)
            update(manifest.toByteArray(Charsets.UTF_8))
            verify(Base64.getDecoder().decode(signatureBase64.trim()))
        }
    } catch (e: Exception) {
        false
    }
}
