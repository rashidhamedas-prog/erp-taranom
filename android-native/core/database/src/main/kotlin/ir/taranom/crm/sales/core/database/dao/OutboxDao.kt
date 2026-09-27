package ir.taranom.crm.sales.core.database.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
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

    @Query("SELECT * FROM outbox_ops WHERE seq = :seq LIMIT 1")
    suspend fun findBySeq(seq: Long): OutboxOpEntity?

    @Query("SELECT COUNT(*) FROM outbox_ops WHERE seq = :seq")
    suspend fun countBySeq(seq: Long): Int

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(op: OutboxOpEntity): Long

    @Query("UPDATE outbox_ops SET replay_proof = :proof WHERE seq = :seq")
    suspend fun updateReplayProof(seq: Long, proof: String)

    @Query(
        """
        UPDATE outbox_ops
        SET status = :status, last_error = :error, attempt_count = attempt_count + 1
        WHERE seq = :seq
        """,
    )
    suspend fun markStatus(seq: Long, status: String, error: String?)

    /**
     * انصراف از یک عملیات متعارض — **فقط با تصمیم صریح کاربر**.
     * ردیف باقی می‌ماند و به `discarded` می‌رود؛ حذف فیزیکی صف ممنوع است
     * (ADR §۸.۲ — «wipe در repair/pairing»).
     */
    @Query("UPDATE outbox_ops SET status = 'discarded' WHERE seq = :seq AND status = 'conflict'")
    suspend fun discardConflict(seq: Long)

    /**
     * Insert then attach Ed25519 proof (seq is part of the signed envelope).
     * [sign] receives the allocated seq and must return base64url proof.
     */
    @Transaction
    suspend fun insertThenSign(
        op: OutboxOpEntity,
        sign: (seq: Long) -> String,
    ): Long {
        val seq = insert(op.copy(seq = 0, replayProof = null))
        val proof = sign(seq)
        updateReplayProof(seq, proof)
        return seq
    }
}
