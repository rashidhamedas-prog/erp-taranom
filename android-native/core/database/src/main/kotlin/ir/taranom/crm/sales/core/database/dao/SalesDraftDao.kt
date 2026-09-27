package ir.taranom.crm.sales.core.database.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Update
import ir.taranom.crm.sales.core.database.entity.OutboxOpEntity
import ir.taranom.crm.sales.core.database.entity.SalesDraftEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface SalesDraftDao {

    @Query("SELECT * FROM sales_drafts ORDER BY updated_at DESC")
    fun observeAll(): Flow<List<SalesDraftEntity>>

    @Query("SELECT * FROM sales_drafts WHERE customer_local_id = :customerLocalId ORDER BY updated_at DESC")
    fun observeForCustomer(customerLocalId: Long): Flow<List<SalesDraftEntity>>

    @Query("SELECT * FROM sales_drafts WHERE local_id = :localId")
    suspend fun findByLocalId(localId: Long): SalesDraftEntity?

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(draft: SalesDraftEntity)

    @Update
    suspend fun update(draft: SalesDraftEntity)

    @Query("SELECT MAX(local_id) FROM sales_drafts WHERE local_id >= :provisionalFloor")
    suspend fun maxProvisionalId(provisionalFloor: Long): Long?

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertOutboxOp(op: OutboxOpEntity): Long

    /** ثبت سند + عملیات outbox به‌صورت اتمیک (ADR §۶.۳). */
    @Transaction
    suspend fun insertWithOutbox(draft: SalesDraftEntity, op: OutboxOpEntity): Long {
        insert(draft)
        return insertOutboxOp(op)
    }
}
