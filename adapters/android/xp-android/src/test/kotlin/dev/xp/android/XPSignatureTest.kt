package dev.xp.android

import org.junit.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Fixture dibuat scripts/sync-fixtures.mjs dengan `xp build --sign` versi Node. */
class XPSignatureTest {
    private val fixture = XPJson.parse(javaClass.classLoader!!.getResource("signed-manifest.json")!!.readText()) as Map<*, *>
    private val manifest = fixture["manifest"] as String
    private val signature = fixture["signature"] as String
    private val publicKey = fixture["publicKey"] as String

    @Test
    fun acceptsSignatureFromNode() = assertTrue(XPSignature.verify(manifest, signature, publicKey))

    @Test
    fun rejectsChangedManifest() = assertFalse(XPSignature.verify(manifest.replace("promo-modal", "promo-modaI"), signature, publicKey))

    @Test
    fun rejectsBrokenSignature() = assertFalse(XPSignature.verify(manifest, signature.reversed(), publicKey))
}
