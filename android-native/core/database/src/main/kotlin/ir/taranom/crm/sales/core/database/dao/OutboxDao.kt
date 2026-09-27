package ir.taranom.crm.sales.core.database.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import ir.taranom.crm.sales.core.database.entity.OutboxOpEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface OutboxDao {

    /** صف به ترتیب [OutboxOpEntity.seq]؛ هرگز مرتب‌سازی دیگری برای ارسال. */
    @Query("SELECT * FROM outbox_ops WHERE status = 'pending' ORDER BY seq ASC LIMIT :limit")
    suspend fun nextPending(limit: Int): List<OutboxOpEntity>

    @Query("SELECT COUNT(*) FROM outbox_ops WHERE status = 'pending'")
    fun observePendingCount(): Flow<Int>

    @Query("SELECT COUNT(*) FROM outbox_ops WHERE status = 'conflict'")
    fun observeConflictCount(): Flow<Int>

    @Query("SELECT * FROM outbox_ops WHERE status = 'conflict' ORDER BY seq ASC")
    fun observeConflicts(): Flow<List<OutboxOpEntity>>

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(op: OutboxOpEntity): Long

    @Query("UPDATE outbox_ops SET status = :status, last_error = :error, attempt_count = attempt_count + 1 WHERE seq = :seq")
    suspend fun markStatus(seq: Long, status: String, error: String?)

    /**
     * انصراف از یک عملیات متعارض — **فقط با تصمیم صریح کاربر**.
     * ردیف باقی می‌ماند و به `discarded` می‌رود؛ حذف فیزیکی صف ممنوع است
     * (ADR §۸.۲ — «wipe در repair/pairing»).
     */
    @Query("UPDATE outbox_ops SET status = 'discarded' WHERE seq = :seq AND status = 'conflict'")
    suspend fun discardConflict(seq: Long)
}
