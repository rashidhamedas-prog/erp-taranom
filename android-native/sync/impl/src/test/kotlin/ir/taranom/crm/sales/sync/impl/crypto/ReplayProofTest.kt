package ir.taranom.crm.sales.sync.impl.crypto

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ReplayProofTest {

    @Test
    fun stableJsonSortsObjectKeys() {
        val s = StableJson.stringify(mapOf("b" to 1, "a" to 2))
        assertEquals("""{"a":2,"b":1}""", s)
    }

    @Test
    fun envelopeCanonicalIsKeySortedAndVerifiable() {
        val kp = ReplayProof.generateKeyPair()
        val body = mapOf("customer_id" to 1L, "type" to "proforma")
        val canonical = ReplayProof.normalizeReplayEnvelope(
            deviceId = 3,
            seq = 12,
            method = "POST",
            path = "/api/invoices",
            userId = 1,
            body = body,
        )
        assertTrue(canonical.startsWith("{"))
        assertTrue(canonical.contains("\"body\":{"))
        assertTrue(canonical.contains("\"device_id\":3"))
        val proof = ReplayProof.sign(kp.privateKeyPem, canonical)
        assertTrue(proof.matches(Regex("^[A-Za-z0-9_-]{80,100}$")))
        assertTrue(ReplayProof.verify(kp.publicKeyPem, proof, canonical))
        assertFalse(ReplayProof.verify(kp.publicKeyPem, proof, canonical + "x"))
    }

    @Test
    fun signEnvelopeRoundTrip() {
        val kp = ReplayProof.generateKeyPair()
        val proof = ReplayProof.signEnvelope(
            privateKeyPem = kp.privateKeyPem,
            deviceId = 1,
            seq = 99,
            method = "POST",
            path = "/api/customers",
            userId = 5,
            body = mapOf("biz" to "فروشگاه تست"),
        )
        val canonical = ReplayProof.normalizeReplayEnvelope(
            deviceId = 1,
            seq = 99,
            method = "POST",
            path = "/api/customers",
            userId = 5,
            body = mapOf("biz" to "فروشگاه تست"),
        )
        assertTrue(ReplayProof.verify(kp.publicKeyPem, proof, canonical))
    }
}
