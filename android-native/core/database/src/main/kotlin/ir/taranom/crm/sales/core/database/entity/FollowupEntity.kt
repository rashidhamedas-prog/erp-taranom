package ir.taranom.crm.sales.core.database.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import ir.taranom.crm.sales.core.model.Followup
import ir.taranom.crm.sales.core.model.SyncState

@Entity(
    tableName = "followups",
    indices = [
        Index(value = ["central_id"], unique = true),
        Index(value = ["customer_local_id"]),
        Index(value = ["date"]),
        Index(value = ["status"]),
    ],
)
data class FollowupEntity(
    @PrimaryKey
    @ColumnInfo(name = "local_id") val localId: Long,
    @ColumnInfo(name = "central_id") val centralId: Long? = null,
    @ColumnInfo(name = "customer_local_id") val customerLocalId: Long,
    @ColumnInfo(name = "user_id") val userId: Long,
    @ColumnInfo(name = "date") val date: String,
    @ColumnInfo(name = "time") val time: String? = null,
    @ColumnInfo(name = "type") val type: String? = null,
    @ColumnInfo(name = "subject") val subject: String,
    @ColumnInfo(name = "note") val note: String? = null,
    @ColumnInfo(name = "action") val action: String? = null,
    @ColumnInfo(name = "next_date") val nextDate: String? = null,
    @ColumnInfo(name = "status") val status: String = "open",
    @ColumnInfo(name = "priority") val priority: String = "mid",
    @ColumnInfo(name = "sync_state") val syncState: String = SyncState.DRAFT.wireValue,
    @ColumnInfo(name = "created_at") val createdAt: Long = 0,
)

fun FollowupEntity.toDomain(): Followup = Followup(
    localId = localId,
    centralId = centralId,
    customerLocalId = customerLocalId,
    userId = userId,
    date = date,
    time = time,
    type = type,
    subject = subject,
    note = note,
    action = action,
    nextDate = nextDate,
    status = status,
    priority = priority,
    syncState = SyncState.fromWire(syncState),
    createdAtEpochMs = createdAt,
)

fun Followup.toEntity(): FollowupEntity = FollowupEntity(
    localId = localId,
    centralId = centralId,
    customerLocalId = customerLocalId,
    userId = userId,
    date = date,
    time = time,
    type = type,
    subject = subject,
    note = note,
    action = action,
    nextDate = nextDate,
    status = status,
    priority = priority,
    syncState = syncState.wireValue,
    createdAt = createdAtEpochMs,
)
