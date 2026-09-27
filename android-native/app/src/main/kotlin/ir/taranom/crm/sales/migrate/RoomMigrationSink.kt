package ir.taranom.crm.sales.migrate

import ir.taranom.crm.sales.core.database.TaranomSalesDatabase
import ir.taranom.crm.sales.core.database.entity.CustomerEntity
import ir.taranom.crm.sales.core.database.entity.OutboxOpEntity
import ir.taranom.crm.sales.core.model.SyncState
import kotlinx.coroutines.runBlocking

/**
 * Sink Room برای migrator — هویت دستگاه هنوز از SecureStore فاز بعد می‌آید؛
 * فعلاً `nativeDeviceId` از provider اختیاری خوانده می‌شود و پیش‌فرض unpaired است.
 */
class RoomMigrationSink(
    private val db: TaranomSalesDatabase,
    private val nativeDeviceIdProvider: () -> Long? = { null },
) : NativeMigrationSink {

    override fun nativeDeviceId(): Long? = nativeDeviceIdProvider()

    override fun hasAnyCustomer(): Boolean = runBlocking {
        db.customerDao().countAll() > 0
    }

    override fun hasOutboxSeq(seq: Long): Boolean = runBlocking {
        db.outboxDao().countBySeq(seq) > 0
    }

    override fun hasCustomerLocalId(localId: Long): Boolean = runBlocking {
        db.customerDao().findByLocalId(localId) != null
    }

    override fun insertCustomer(row: LegacyCustomerRow) = runBlocking {
        db.customerDao().insert(
            CustomerEntity(
                localId = row.id,
                centralId = if (row.id < 1_000_000_000_000L) row.id else null,
                businessName = row.businessName,
                ownerName = row.ownerName,
                city = row.city,
                phone = row.phone,
                ownerUserId = row.ownerUserId,
                syncState = SyncState.ACCEPTED_CENTRAL.wireValue,
                version = row.version,
                updatedAt = row.updatedAtEpochMs,
            ),
        )
    }

    override fun insertOutbox(row: LegacyOutboxRow) = runBlocking {
        db.outboxDao().insert(
            OutboxOpEntity(
                seq = row.id,
                method = row.method,
                path = row.path,
                bodyJson = row.bodyJson,
                userId = row.userId,
                baseVersion = row.baseVersion,
                capturedRowsJson = row.capturedRowsJson,
                replayProof = row.replayProof,
                status = row.status,
                attemptCount = row.attempts,
                lastError = row.lastError,
                createdAt = row.createdAtEpochMs,
            ),
        )
        Unit
    }
}
