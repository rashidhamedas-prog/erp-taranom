package ir.taranom.crm.sales.core.database.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import ir.taranom.crm.sales.core.model.CallLog
import ir.taranom.crm.sales.core.model.SyncState
import ir.taranom.crm.sales.core.model.VisitLog

@Entity(
    tableName = "visit_logs",
    indices = [
        Index(value = ["central_id"], unique = true),
        Index(value = ["customer_local_id"]),
        Index(value = ["rep_id"]),
        Index(value = ["date"]),
    ],
)
data class VisitLogEntity(
    @PrimaryKey
    @ColumnInfo(name = "local_id") val localId: Long,
    @ColumnInfo(name = "central_id") val centralId: Long? = null,
    @ColumnInfo(name = "rep_id") val repId: Long,
    @ColumnInfo(name = "customer_local_id") val customerLocalId: Long,
    @ColumnInfo(name = "date") val date: String,
    @ColumnInfo(name = "note") val note: String? = null,
    @ColumnInfo(name = "lat") val lat: Double? = null,
    @ColumnInfo(name = "lng") val lng: Double? = null,
    @ColumnInfo(name = "check_in_at") val checkInAt: Long? = null,
    @ColumnInfo(name = "check_out_at") val checkOutAt: Long? = null,
    @ColumnInfo(name = "sync_state") val syncState: String = SyncState.DRAFT.wireValue,
    @ColumnInfo(name = "created_at") val createdAt: Long = 0,
)

fun VisitLogEntity.toDomain(): VisitLog = VisitLog(
    localId = localId,
    centralId = centralId,
    repId = repId,
    customerLocalId = customerLocalId,
    date = date,
    note = note,
    lat = lat,
    lng = lng,
    checkInAtEpochSec = checkInAt,
    checkOutAtEpochSec = checkOutAt,
    syncState = SyncState.fromWire(syncState),
    createdAtEpochMs = createdAt,
)

fun VisitLog.toEntity(): VisitLogEntity = VisitLogEntity(
    localId = localId,
    centralId = centralId,
    repId = repId,
    customerLocalId = customerLocalId,
    date = date,
    note = note,
    lat = lat,
    lng = lng,
    checkInAt = checkInAtEpochSec,
    checkOutAt = checkOutAtEpochSec,
    syncState = syncState.wireValue,
    createdAt = createdAtEpochMs,
)

@Entity(
    tableName = "call_logs",
    indices = [
        Index(value = ["central_id"], unique = true),
        Index(value = ["customer_local_id"]),
        Index(value = ["rep_id"]),
        Index(value = ["date"]),
    ],
)
data class CallLogEntity(
    @PrimaryKey
    @ColumnInfo(name = "local_id") val localId: Long,
    @ColumnInfo(name = "central_id") val centralId: Long? = null,
    @ColumnInfo(name = "rep_id") val repId: Long,
    @ColumnInfo(name = "customer_local_id") val customerLocalId: Long,
    @ColumnInfo(name = "date") val date: String,
    @ColumnInfo(name = "duration_min") val durationMin: Int = 0,
    @ColumnInfo(name = "outcome") val outcome: String? = null,
    @ColumnInfo(name = "note") val note: String? = null,
    @ColumnInfo(name = "sync_state") val syncState: String = SyncState.DRAFT.wireValue,
    @ColumnInfo(name = "created_at") val createdAt: Long = 0,
)

fun CallLogEntity.toDomain(): CallLog = CallLog(
    localId = localId,
    centralId = centralId,
    repId = repId,
    customerLocalId = customerLocalId,
    date = date,
    durationMin = durationMin,
    outcome = outcome,
    note = note,
    syncState = SyncState.fromWire(syncState),
    createdAtEpochMs = createdAt,
)

fun CallLog.toEntity(): CallLogEntity = CallLogEntity(
    localId = localId,
    centralId = centralId,
    repId = repId,
    customerLocalId = customerLocalId,
    date = date,
    durationMin = durationMin,
    outcome = outcome,
    note = note,
    syncState = syncState.wireValue,
    createdAt = createdAtEpochMs,
)
