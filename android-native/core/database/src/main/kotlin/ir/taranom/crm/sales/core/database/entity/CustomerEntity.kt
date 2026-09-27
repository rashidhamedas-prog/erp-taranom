package ir.taranom.crm.sales.core.database.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import ir.taranom.crm.sales.core.model.Customer
import ir.taranom.crm.sales.core.model.SyncState

/**
 * مشتری روی دستگاه. [localId] با فرمول provisional ساخته می‌شود تا با شناسه‌های
 * مرکز تصادم نکند (`ProvisionalIds.tableBase`).
 *
 * نام ستون‌ها عمداً snake_case و هم‌شکل سرور است تا body عملیات outbox بدون
 * نگاشت اضافه ساخته شود.
 */
@Entity(
    tableName = "customers",
    indices = [
        Index(value = ["central_id"], unique = true),
        Index(value = ["owner_user_id"]),
        Index(value = ["sync_state"]),
    ],
)
data class CustomerEntity(
    @PrimaryKey
    @ColumnInfo(name = "local_id") val localId: Long,
    @ColumnInfo(name = "central_id") val centralId: Long? = null,
    @ColumnInfo(name = "business_name") val businessName: String,
    @ColumnInfo(name = "owner_name") val ownerName: String? = null,
    @ColumnInfo(name = "city") val city: String? = null,
    @ColumnInfo(name = "phone") val phone: String? = null,
    @ColumnInfo(name = "owner_user_id") val ownerUserId: Long? = null,
    @ColumnInfo(name = "sync_state") val syncState: String = SyncState.DRAFT.wireValue,
    @ColumnInfo(name = "version") val version: Long = 0,
    @ColumnInfo(name = "updated_at") val updatedAt: Long = 0,
)

fun CustomerEntity.toDomain(): Customer = Customer(
    localId = localId,
    centralId = centralId,
    businessName = businessName,
    ownerName = ownerName,
    city = city,
    phone = phone,
    ownerUserId = ownerUserId,
    syncState = SyncState.fromWire(syncState),
    version = version,
    updatedAtEpochMs = updatedAt,
)

fun Customer.toEntity(): CustomerEntity = CustomerEntity(
    localId = localId,
    centralId = centralId,
    businessName = businessName,
    ownerName = ownerName,
    city = city,
    phone = phone,
    ownerUserId = ownerUserId,
    syncState = syncState.wireValue,
    version = version,
    updatedAt = updatedAtEpochMs,
)
