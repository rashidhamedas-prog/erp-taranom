package ir.taranom.crm.sales.sync.impl.crypto

import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/**
 * Ed25519 replay attestation — matches `server/sync/device-auth.js`
 * (PKCS8 / SPKI PEM, signature base64url).
 */
object ReplayProof {
    const val VERSION = 1

    data class KeyPairPem(val publicKeyPem: String, val privateKeyPem: String)

    fun generateKeyPair(): KeyPairPem {
        val kpg = KeyPairGenerator.getInstance("Ed25519")
        val kp = kpg.generateKeyPair()
        return KeyPairPem(
            publicKeyPem = encodePem("PUBLIC KEY", kp.public.encoded),
            privateKeyPem = encodePem("PRIVATE KEY", kp.private.encoded),
        )
    }

    fun normalizeReplayEnvelope(
        deviceId: Long,
        seq: Long,
        method: String,
        path: String,
        userId: Long,
        body: Map<String, Any?>,
        fileHash: String = "",
        fileField: String = "",
    ): String {
        require(deviceId > 0 && seq > 0 && userId > 0) { "Replay envelope identifiers are invalid" }
        require(method in setOf("POST", "PUT", "PATCH", "DELETE")) { "Replay envelope method is invalid" }
        require(path.startsWith("/api/") && path.length <= 2048) { "Replay envelope path is invalid" }
        require(path.none { it.code < 0x20 || it.code == 0x7f }) { "Replay envelope path is invalid" }
        val hash = fileHash.lowercase()
        require(hash.isEmpty() || hash.matches(Regex("^[a-f0-9]{64}$"))) { "Replay envelope file hash is invalid" }
        require(fileField.isEmpty() || fileField.matches(Regex("^[A-Za-z][A-Za-z0-9_]{0,63}$"))) {
            "Replay envelope file field is invalid"
        }
        // Key order must match Node stableJson sorted keys of the envelope object.
        val envelope = mapOf(
            "body" to body,
            "device_id" to deviceId,
            "file_field" to fileField,
            "file_sha256" to hash,
            "method" to method,
            "path" to path,
            "seq" to seq,
            "user_id" to userId,
            "version" to VERSION,
        )
        val canonical = StableJson.stringify(envelope)
        require(canonical.toByteArray(Charsets.UTF_8).size <= 2 * 1024 * 1024 + 8192) {
            "Replay envelope is too large"
        }
        return canonical
    }

    fun sign(privateKeyPem: String, canonicalUtf8: String): String {
        val raw = privateKeyPem.trim()
        require(raw.isNotEmpty() && raw.length <= 2048) { "Device replay private key is invalid" }
        val key = KeyFactory.getInstance("Ed25519")
            .generatePrivate(PKCS8EncodedKeySpec(decodePem(raw)))
        val sig = Signature.getInstance("Ed25519")
        sig.initSign(key)
        sig.update(canonicalUtf8.toByteArray(Charsets.UTF_8))
        return Base64.getUrlEncoder().withoutPadding().encodeToString(sig.sign())
    }

    fun verify(publicKeyPem: String, proof: String, canonicalUtf8: String): Boolean {
        return try {
            if (!proof.matches(Regex("^[A-Za-z0-9_-]{80,100}$"))) return false
            val raw = publicKeyPem.trim()
            require(raw.isNotEmpty() && raw.length <= 1024)
            val key = KeyFactory.getInstance("Ed25519")
                .generatePublic(X509EncodedKeySpec(decodePem(raw)))
            val sig = Signature.getInstance("Ed25519")
            sig.initVerify(key)
            sig.update(canonicalUtf8.toByteArray(Charsets.UTF_8))
            sig.verify(Base64.getUrlDecoder().decode(proof))
        } catch (_: Exception) {
            false
        }
    }

    fun signEnvelope(
        privateKeyPem: String,
        deviceId: Long,
        seq: Long,
        method: String,
        path: String,
        userId: Long,
        body: Map<String, Any?>,
        fileHash: String = "",
        fileField: String = "",
    ): String {
        val canonical = normalizeReplayEnvelope(deviceId, seq, method, path, userId, body, fileHash, fileField)
        return sign(privateKeyPem, canonical)
    }

    private fun encodePem(type: String, der: ByteArray): String {
        val b64 = Base64.getMimeEncoder(64, "\n".toByteArray()).encodeToString(der)
        return "-----BEGIN $type-----\n$b64\n-----END $type-----\n"
    }

    private fun decodePem(pem: String): ByteArray {
        val b64 = pem.lines()
            .filter { !it.startsWith("-----") && it.isNotBlank() }
            .joinToString("")
        return Base64.getDecoder().decode(b64)
    }
}
