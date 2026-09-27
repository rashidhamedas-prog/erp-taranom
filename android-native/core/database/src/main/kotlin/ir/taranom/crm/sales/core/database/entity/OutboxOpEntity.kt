package ir.taranom.crm.sales.core.database.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import ir.taranom.crm.sales.core.model.OutboxOp
import ir.taranom.crm.sales.core.model.OutboxStatus

/**
 * صف خروجی. [seq] ترتیب ارسال است و **هرگز** بازنویسی/مرتب‌سازی مجدد نمی‌شود؛
 * پردازش با اولین `conflict` متوقف می‌ماند تا وابستگی اسناد حفظ شود.
 *
 * حذف فیزیکی ردیف `pending` ممنوع است — «repair» یا pairing مجدد نباید صف را
 * بی‌صدا پاک کند (ADR §۸.۲).
 */
@Entity(
    tableName = "outbox_ops",
    indices = [
        Index(value = ["status"]),
        Index(value = ["created_at"]),
    ],
)
data class OutboxOpEntity(
    @PrimaryKey(autoGenerate = true)
    @ColumnInfo(name = "seq") val seq: Long = 0,
    @ColumnInfo(name = "method") val method: String,
    @ColumnInfo(name = "path") val path: String,
    @ColumnInfo(name = "body_json") val bodyJson: String,
    /** بازپخش مرکز با هویت همین کاربر انجام می‌شود، نه کاربر فعلی دستگاه. */
    @ColumnInfo(name = "user_id") val userId: Long,
    @ColumnInfo(name = "base_version") val baseVersion: Long? = null,
    @ColumnInfo(name = "entity_table") val entityTable: String? = null,
    @ColumnInfo(name = "entity_local_id") val entityLocalId: Long? = null,
    @ColumnInfo(name = "captured_rows_json") val capturedRowsJson: String? = null,
    /** امضای Ed25519 عملیات؛ کلید خصوصی در Keystore می‌ماند. */
    @ColumnInfo(name = "replay_proof") val replayProof: String? = null,
    @ColumnInfo(name = "file_hash") val fileHash: String? = null,
    @ColumnInfo(name = "file_field") val fileField: String? = null,
    @ColumnInfo(name = "status") val status: String = OutboxStatus.PENDING.wireValue,
    @ColumnInfo(name = "attempt_count") val attemptCount: Int = 0,
    @ColumnInfo(name = "last_error") val lastError: String? = null,
    @ColumnInfo(name = "created_at") val createdAt: Long = 0,
)

fun OutboxOpEntity.toDomain(): OutboxOp = OutboxOp(
    seq = seq,
    method = method,
    path = path,
    bodyJson = bodyJson,
    userId = userId,
    baseVersion = baseVersion,
    entityTable = entityTable,
    entityLocalId = entityLocalId,
    capturedRowsJson = capturedRowsJson,
    replayProof = replayProof,
    fileHash = fileHash,
    fileField = fileField,
    status = OutboxStatus.fromWire(status),
    attemptCount = attemptCount,
    lastError = lastError,
    createdAtEpochMs = createdAt,
)

fun OutboxOp.toEntity(): OutboxOpEntity = OutboxOpEntity(
    seq = seq,
    method = method,
    path = path,
    bodyJson = bodyJson,
    userId = userId,
    baseVersion = baseVersion,
    entityTable = entityTable,
    entityLocalId = entityLocalId,
    capturedRowsJson = capturedRowsJson,
    replayProof = replayProof,
    fileHash = fileHash,
    fileField = fileField,
    status = status.wireValue,
    attemptCount = attemptCount,
    lastError = lastError,
    createdAt = createdAtEpochMs,
)
