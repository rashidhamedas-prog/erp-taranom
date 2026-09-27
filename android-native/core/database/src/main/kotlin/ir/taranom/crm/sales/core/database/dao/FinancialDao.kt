package ir.taranom.crm.sales.core.database.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import ir.taranom.crm.sales.core.database.entity.InvoiceEntity
import ir.taranom.crm.sales.core.database.entity.OutboxOpEntity
import ir.taranom.crm.sales.core.database.entity.ReceiptEntity
import ir.taranom.crm.sales.core.database.entity.SalesReturnEntity
import ir.taranom.crm.sales.core.database.entity.SyncConflictEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface InvoiceDao {
    @Query("SELECT * FROM invoices ORDER BY updated_at DESC")
    fun observeAll(): Flow<List<InvoiceEntity>>

    @Query("SELECT COUNT(*) FROM invoices")
    fun observeCount(): Flow<Int>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(invoice: InvoiceEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertOutboxOp(op: OutboxOpEntity): Long

    @Query("SELECT MAX(local_id) FROM invoices WHERE local_id >= :floor")
    suspend fun maxProvisionalId(floor: Long): Long?

    @Transaction
    suspend fun insertWithOutbox(invoice: InvoiceEntity, op: OutboxOpEntity): Long {
        upsert(invoice)
        return insertOutboxOp(op)
    }
}

@Dao
interface ReceiptDao {
    @Query("SELECT * FROM receipts ORDER BY created_at DESC")
    fun observeAll(): Flow<List<ReceiptEntity>>

    @Query("SELECT IFNULL(SUM(amount), 0) FROM receipts")
    fun observeTotalAmount(): Flow<Long>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(receipt: ReceiptEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertOutboxOp(op: OutboxOpEntity): Long

    @Query("SELECT MAX(local_id) FROM receipts WHERE local_id >= :floor")
    suspend fun maxProvisionalId(floor: Long): Long?

    @Transaction
    suspend fun insertWithOutbox(receipt: ReceiptEntity, op: OutboxOpEntity): Long {
        upsert(receipt)
        return insertOutboxOp(op)
    }
}

@Dao
interface SalesReturnDao {
    @Query("SELECT * FROM sales_returns ORDER BY created_at DESC")
    fun observeAll(): Flow<List<SalesReturnEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(row: SalesReturnEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertOutboxOp(op: OutboxOpEntity): Long

    @Query("SELECT MAX(local_id) FROM sales_returns WHERE local_id >= :floor")
    suspend fun maxProvisionalId(floor: Long): Long?

    @Transaction
    suspend fun insertWithOutbox(row: SalesReturnEntity, op: OutboxOpEntity): Long {
        upsert(row)
        return insertOutboxOp(op)
    }
}

@Dao
interface SyncConflictDao {
    @Query("SELECT * FROM sync_conflicts WHERE resolved = 0 ORDER BY created_at DESC")
    fun observeOpen(): Flow<List<SyncConflictEntity>>

    @Query("SELECT COUNT(*) FROM sync_conflicts WHERE resolved = 0")
    fun observeOpenCount(): Flow<Int>

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(conflict: SyncConflictEntity): Long

    @Query("UPDATE sync_conflicts SET resolved = 1 WHERE id = :id")
    suspend fun markResolved(id: Long)
}
