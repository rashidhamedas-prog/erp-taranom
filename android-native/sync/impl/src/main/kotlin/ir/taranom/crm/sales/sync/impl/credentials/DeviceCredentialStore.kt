package ir.taranom.crm.sales.sync.impl.credentials

import ir.taranom.crm.sales.sync.api.DeviceCredentials
import ir.taranom.crm.sales.sync.impl.crypto.DeviceHmac
import ir.taranom.crm.sales.sync.impl.crypto.JsonMaps
import ir.taranom.crm.sales.sync.impl.crypto.ReplayProof

/**
 * Persists pairing material. Secrets are AES-GCM sealed with [masterKeyProvider].
 *
 * On Android, prefer EncryptedSharedPreferences as [store] and a Keystore-backed
 * 32-byte master key (see [AndroidCredentialWiring] docs in NATIVE-ANDROID-EVIDENCE.md).
 */
class DeviceCredentialStore(
    private val store: StringKeyValueStore,
    private val masterKeyProvider: () -> ByteArray,
    private val clock: () -> Long = { System.currentTimeMillis() / 1000L },
) : DeviceCredentials {

    companion object {
        private const val K_DEVICE_ID = "device_id"
        private const val K_CENTRAL_URL = "central_url"
        private const val K_TOKEN = "device_token"
        private const val K_PRIV = "device_signing_private_key"
        private const val K_PUB = "device_signing_public_key"
        private const val K_LAST_PULL = "last_pull_seq"
        private const val K_INITIAL_DONE = "initial_sync_done"
    }

    override val deviceId: Long?
        get() = store.getString(K_DEVICE_ID)?.toLongOrNull()

    override val centralUrl: String?
        get() = store.getString(K_CENTRAL_URL)

    override fun hasDeviceToken(): Boolean = readSecret(K_TOKEN) != null

    override fun authorizationHeader(): String? {
        val id = deviceId ?: return null
        val token = readSecret(K_TOKEN) ?: return null
        return "Device $id:$token"
    }

    override fun hmacSignature(timestampSec: Long, nonce: String): String {
        val token = readSecret(K_TOKEN)
            ?: throw MissingCredentialsException("device_token missing — pair again")
        return DeviceHmac.signature(token, timestampSec, nonce)
    }

    override fun signReplayProof(
        seq: Long,
        method: String,
        path: String,
        userId: Long,
        body: Map<String, Any?>,
        fileHash: String,
        fileField: String,
    ): String {
        val id = deviceId
            ?: throw MissingCredentialsException("device_id missing — pair again")
        val priv = readSecret(K_PRIV)
            ?: throw MissingCredentialsException("signing key missing — pair again")
        return ReplayProof.signEnvelope(priv, id, seq, method, path, userId, body, fileHash, fileField)
    }

    override fun replayPublicKeyPem(): String =
        store.getString(K_PUB)
            ?: throw MissingCredentialsException("public key missing — generate before pair")

    override fun freshNonce(): String = DeviceHmac.freshNonce()

    override fun nowEpochSeconds(): Long = clock()

    fun lastPullSeq(): Long = store.getString(K_LAST_PULL)?.toLongOrNull() ?: -1L

    fun setLastPullSeq(seq: Long) {
        store.putString(K_LAST_PULL, seq.toString())
    }

    fun isInitialSyncDone(): Boolean = store.getString(K_INITIAL_DONE) == "1"

    fun markInitialSyncDone() {
        store.putString(K_INITIAL_DONE, "1")
    }

    /** Generate Ed25519 keypair before calling central /pair. */
    fun prepareSigningKeys(): String {
        val kp = ReplayProof.generateKeyPair()
        writeSecret(K_PRIV, kp.privateKeyPem)
        store.putString(K_PUB, kp.publicKeyPem)
        return kp.publicKeyPem
    }

    fun savePairing(centralUrl: String, deviceId: Long, deviceToken: String) {
        require(centralUrl.isNotBlank() && deviceId > 0 && deviceToken.isNotBlank()) {
            "Invalid pairing payload"
        }
        store.putString(K_CENTRAL_URL, centralUrl.trim().trimEnd('/'))
        store.putString(K_DEVICE_ID, deviceId.toString())
        writeSecret(K_TOKEN, deviceToken)
        store.putString(K_LAST_PULL, "-1")
        store.remove(K_INITIAL_DONE)
    }

    fun clearPairing() {
        listOf(K_DEVICE_ID, K_CENTRAL_URL, K_TOKEN, K_PRIV, K_PUB, K_LAST_PULL, K_INITIAL_DONE)
            .forEach { key ->
                when (key) {
                    K_TOKEN, K_PRIV -> store.remove(key)
                    else -> store.remove(key)
                }
            }
        store.clear()
    }

    fun signOutboxBody(
        seq: Long,
        method: String,
        path: String,
        userId: Long,
        bodyJson: String,
        fileHash: String = "",
        fileField: String = "",
    ): String = signReplayProof(
        seq = seq,
        method = method,
        path = path,
        userId = userId,
        body = JsonMaps.parseObject(bodyJson),
        fileHash = fileHash,
        fileField = fileField,
    )

    private fun writeSecret(key: String, plaintext: String) {
        val sealed = AesGcmBox.seal(masterKeyProvider(), plaintext.toByteArray(Charsets.UTF_8))
        store.putString(key, sealed)
    }

    private fun readSecret(key: String): String? {
        val sealed = store.getString(key) ?: return null
        return try {
            String(AesGcmBox.open(masterKeyProvider(), sealed), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }
}

class MissingCredentialsException(message: String) : IllegalStateException(message)
