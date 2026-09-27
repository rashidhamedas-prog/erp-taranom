package ir.taranom.crm.sales.core.model

/**
 * لاگ تماس — `rep_call_logs` / `POST /api/reps/:id/calls`.
 * **بدون ضبط صدا** (فقط مدت/نتیجه/یادداشت).
 */
data class CallLog(
    val localId: Long,
    val centralId: Long? = null,
    val repId: Long,
    val customerLocalId: Long,
    val date: String,
    val durationMin: Int = 0,
    val outcome: String? = null,
    val note: String? = null,
    val syncState: SyncState = SyncState.DRAFT,
    val createdAtEpochMs: Long = 0,
)
