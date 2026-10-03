import CryptoKit
import Foundation

/// Verifikasi manifest.sig hasil `xp build --sign`: ECDSA P-256 + SHA-256, tanda tangan DER.
/// Kunci publik: base64 SPKI DER (isi xp-public-key.txt).
public enum XPSignature {
    public static func verify(manifest: Data, signatureBase64: String, publicKeyBase64: String) -> Bool {
        guard
            let keyData = Data(base64Encoded: publicKeyBase64.trimmingCharacters(in: .whitespacesAndNewlines)),
            let sigData = Data(base64Encoded: signatureBase64.trimmingCharacters(in: .whitespacesAndNewlines)),
            let key = try? P256.Signing.PublicKey(derRepresentation: keyData),
            let signature = try? P256.Signing.ECDSASignature(derRepresentation: sigData)
        else { return false }
        return key.isValidSignature(signature, for: manifest)
    }
}
