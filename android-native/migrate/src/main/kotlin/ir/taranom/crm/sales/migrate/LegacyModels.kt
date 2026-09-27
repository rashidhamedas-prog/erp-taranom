package ir.taranom.crm.sales.migrate

/**
 * دسترسی فقط‌خواندنی به SQLite legacy بدون وابستگی به Android SDK.
 * پیاده‌سازی واقعی در `:app` با `SQLiteDatabase.openDatabase(..., OPEN_READONLY)`.
 */
interface LegacySqliteSource : AutoCloseable {
    fun exists(): Boolean
    fun tableExists(name: String): Boolean
    fun queryRows(table: String, columns: List<String>, where: String? = null): List<Map<String, String?>>
}

data class LegacyCustomerRow(
    val id: Long,
    val businessName: String,
    val ownerName: String?,
    val city: String?,
    val phone: String?,
    val ownerUserId: Long?,
    val version: Long,
    val updatedAtEpochMs: Long,
)

data class LegacyOutboxRow(
    val id: Long,
    val method: String,
    val path: String,
    val bodyJson: String,
    val userId: Long,
    val baseVersion: Long?,
    val capturedRowsJson: String?,
    val replayProof: String?,
    val status: String,
    val attempts: Int,
    val lastError: String?,
    val createdAtEpochMs: Long,
)

data class LegacyIdentityProbe(
    val deviceId: Long?,
    val centralUrl: String?,
    /** true اگر هر کلید ممنوعه در kv دیده شد (مقدار خوانده/صادر نمی‌شود). */
    val secretsPresentButNotExported: Boolean,
)

sealed class MigrationOutcome {
    data class Skipped(val reason: String) : MigrationOutcome()
    data class Aborted(val code: String, val detail: String? = null) : MigrationOutcome()
    data class Completed(
        val customersCopied: Int,
        val outboxCopied: Int,
        val identity: IdentityDecision,
        val notes: List<String> = emptyList(),
    ) : MigrationOutcome()
}

/**
 * مقصد نوشتن Room — پیاده‌سازی در `:app` روی DAOها.
 */
interface NativeMigrationSink {
    fun nativeDeviceId(): Long?
    fun hasAnyCustomer(): Boolean
    fun hasOutboxSeq(seq: Long): Boolean
    fun hasCustomerLocalId(localId: Long): Boolean
    fun insertCustomer(row: LegacyCustomerRow)
    fun insertOutbox(row: LegacyOutboxRow)
}
