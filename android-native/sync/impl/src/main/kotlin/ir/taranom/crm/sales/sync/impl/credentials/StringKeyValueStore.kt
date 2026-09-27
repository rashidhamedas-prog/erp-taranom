package ir.taranom.crm.sales.sync.impl.credentials

/**
 * Thin KV facade so EncryptedSharedPreferences (Android) or an in-memory map
 * (JVM tests) can back [DeviceCredentialStore] without pulling Android APIs
 * into this JVM module.
 */
interface StringKeyValueStore {
    fun getString(key: String): String?
    fun putString(key: String, value: String)
    fun remove(key: String)
    fun clear()
}

class InMemoryKeyValueStore : StringKeyValueStore {
    private val map = linkedMapOf<String, String>()
    override fun getString(key: String): String? = map[key]
    override fun putString(key: String, value: String) { map[key] = value }
    override fun remove(key: String) { map.remove(key) }
    override fun clear() { map.clear() }
}
