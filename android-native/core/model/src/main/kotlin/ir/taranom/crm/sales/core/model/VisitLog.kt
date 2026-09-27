package ir.taranom.crm.sales.core.model

/**
 * لاگ ویزیت میدانی — `rep_visit_logs` / `POST /api/reps/:id/visits`.
 * بدون ضبط مکالمه یا رسانهٔ اجباری.
 */
data class VisitLog(
    val localId: Long,
    val centralId: Long? = null,
    val repId: Long,
    val customerLocalId: Long,
    val date: String,
    val note: String? = null,
    val lat: Double? = null,
    val lng: Double? = null,
    val checkInAtEpochSec: Long? = null,
    val checkOutAtEpochSec: Long? = null,
    val syncState: SyncState = SyncState.DRAFT,
    val createdAtEpochMs: Long = 0,
)
