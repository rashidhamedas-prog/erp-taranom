package ir.taranom.crm.sales.sync.impl.crypto

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class DeviceHmacTest {

    @Test
    fun tokenHashIsSha256HexOfToken() {
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            DeviceHmac.tokenHash("abc"),
        )
    }

    @Test
    fun signatureMatchesNodeDeviceAuthFormula() {
        val token = "deadbeef".repeat(8)
        val ts = 1_700_000_000L
        val nonce = "a".repeat(36)
        val sig = DeviceHmac.signature(token, ts, nonce)
        assertEquals(64, sig.length)
        assertTrue(sig.matches(Regex("^[a-f0-9]{64}$")))
        assertEquals(sig, DeviceHmac.signature(token, ts, nonce))
        assertNotEquals(sig, DeviceHmac.signature(token, ts + 1, nonce))
    }

    @Test
    fun freshNonceIs36HexChars() {
        val n = DeviceHmac.freshNonce()
        assertEquals(36, n.length)
        assertTrue(n.matches(Regex("^[a-f0-9]{36}$")))
    }

    @Test
    fun alreadyHashedPathUsesTokenHashAsKeyMaterial() {
        val token = "aabbccdd"
        val hash = DeviceHmac.tokenHash(token)
        val ts = 100L
        val nonce = "b".repeat(36)
        assertEquals(
            DeviceHmac.signature(token, ts, nonce),
            DeviceHmac.signature(hash, ts, nonce, alreadyHashed = true),
        )
    }
}
