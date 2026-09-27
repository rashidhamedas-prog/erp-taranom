package ir.taranom.crm.sales.sync.impl.crypto

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Device transport auth — byte-compatible with `server/sync/device-auth.js`.
 */
object DeviceHmac {
    const val MAX_CLOCK_SKEW_SEC = 300L
    private val random = SecureRandom()

    fun tokenHash(token: String): String =
        sha256Hex(token.toByteArray(Charsets.UTF_8))

    /**
     * HMAC-SHA256 hex of `"$timestamp:$nonce"`.
     * Key = SHA-256(token) hex string as UTF-8 bytes (Node uses hex digest string as HMAC key).
     */
    fun signature(tokenOrHash: String, timestamp: Long, nonce: String, alreadyHashed: Boolean = false): String {
        val key = if (alreadyHashed) tokenOrHash else tokenHash(tokenOrHash)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal("$timestamp:$nonce".toByteArray(Charsets.UTF_8)).toHex()
    }

    /** 18 random bytes → 36 hex chars (central regex `^[a-f0-9]{36}$`). */
    fun freshNonce(): String {
        val buf = ByteArray(18)
        random.nextBytes(buf)
        return buf.toHex()
    }

    fun sha256Hex(data: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(data).toHex()

    private fun ByteArray.toHex(): String {
        val out = CharArray(size * 2)
        val hex = "0123456789abcdef"
        for (i in indices) {
            val v = this[i].toInt() and 0xff
            out[i * 2] = hex[v ushr 4]
            out[i * 2 + 1] = hex[v and 0x0f]
        }
        return String(out)
    }
}
