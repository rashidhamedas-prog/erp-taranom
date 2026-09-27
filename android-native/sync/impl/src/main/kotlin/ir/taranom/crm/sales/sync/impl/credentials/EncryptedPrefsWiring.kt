package ir.taranom.crm.sales.sync.impl.credentials

/**
 * How to wire Android EncryptedSharedPreferences / Keystore without compiling
 * Android APIs into this JVM module:
 *
 * ```kotlin
 // app or android library:
 * val masterKey = MasterKey.Builder(context)
 *     .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
 *     .build()
 * val prefs = EncryptedSharedPreferences.create(
 *     context,
 *     "taranom_sync_device_v1",
 *     masterKey,
 *     EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
 *     EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
 * )
 * val store = object : StringKeyValueStore {
 *     override fun getString(key: String) = prefs.getString(key, null)
 *     override fun putString(key: String, value: String) { prefs.edit().putString(key, value).apply() }
 *     override fun remove(key: String) { prefs.edit().remove(key).apply() }
 *     override fun clear() { prefs.edit().clear().apply() }
 * }
 * // Prefer a dedicated 32-byte key from Android Keystore for AesGcmBox:
 * val vault = DeviceCredentialStore(store) { keystoreAesKey32() }
 * ```
 *
 * Fail closed: never fall back to plaintext SharedPreferences for device_token
 * or Ed25519 private key.
 */
object EncryptedPrefsWiring {
    const val PREFS_NAME = "taranom_sync_device_v1"
}
