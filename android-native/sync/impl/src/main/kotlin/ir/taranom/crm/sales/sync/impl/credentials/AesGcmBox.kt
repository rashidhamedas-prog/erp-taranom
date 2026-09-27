package ir.taranom.crm.sales.sync.impl.credentials

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import java.util.Base64

/**
 * AES-256-GCM envelope for device secrets at rest.
 * Master key (32 bytes) should come from Android Keystore / EncryptedSharedPreferences
 * keyset — never hard-coded.
 */
object AesGcmBox {
    private const val GCM_TAG_BITS = 128
    private const val IV_BYTES = 12
    private val random = SecureRandom()

    fun seal(masterKey: ByteArray, plaintext: ByteArray): String {
        require(masterKey.size == 32) { "Master key must be 32 bytes" }
        val iv = ByteArray(IV_BYTES).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(masterKey, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
        val ct = cipher.doFinal(plaintext)
        val packed = iv + ct
        return "enc:v1:" + Base64.getEncoder().encodeToString(packed)
    }

    fun open(masterKey: ByteArray, sealed: String): ByteArray {
        require(masterKey.size == 32) { "Master key must be 32 bytes" }
        require(sealed.startsWith("enc:v1:")) { "Unsupported secret envelope" }
        val packed = Base64.getDecoder().decode(sealed.removePrefix("enc:v1:"))
        require(packed.size > IV_BYTES) { "Corrupt secret envelope" }
        val iv = packed.copyOfRange(0, IV_BYTES)
        val ct = packed.copyOfRange(IV_BYTES, packed.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(masterKey, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
        return cipher.doFinal(ct)
    }

    fun randomMasterKey(): ByteArray = ByteArray(32).also { random.nextBytes(it) }
}
