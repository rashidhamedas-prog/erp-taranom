package ir.taranom.crm.sales.core.model

/**
 * پیگیری / برنامهٔ روزانه — هم‌شکل جدول `followups` سرور.
 */
data class Followup(
    val localId: Long,
    val centralId: Long? = null,
    val customerLocalId: Long,
    val userId: Long,
    val date: String,
    val time: String? = null,
    val type: String? = null,
    val subject: String,
    val note: String? = null,
    val action: String? = null,
    val nextDate: String? = null,
    val status: String = "open",
    val priority: String = "mid",
    val syncState: SyncState = SyncState.DRAFT,
    val createdAtEpochMs: Long = 0,
)
