package ir.taranom.crm.sales.core.database.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Update
import ir.taranom.crm.sales.core.database.entity.OutboxOpEntity
import ir.taranom.crm.sales.core.database.entity.SalesDraftEntity
import ir.taranom.crm.sales.core.database.entity.SalesDraftLineEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface SalesDraftDao {

    @Query("SELECT * FROM sales_drafts ORDER BY updated_at DESC")
    fun observeAll(): Flow<List<SalesDraftEntity>>

    @Query("SELECT * FROM sales_drafts WHERE customer_local_id = :customerLocalId ORDER BY updated_at DESC")
    fun observeForCustomer(customerLocalId: Long): Flow<List<SalesDraftEntity>>

    /** آخرین پیش‌نویس باز برای بازیابی پایدار سبد پس از kill/چرخش. */
    @Query(
        """
        SELECT * FROM sales_drafts
        WHERE sync_state = 'draft'
        ORDER BY updated_at DESC
        LIMIT 1
        """
    )
    fun observeLatestOpen(): Flow<SalesDraftEntity?>

    @Query(
        """
        SELECT * FROM sales_drafts
        WHERE sync_state = 'draft'
        ORDER BY updated_at DESC
        LIMIT 1
        """
    )
    suspend fun findLatestOpen(): SalesDraftEntity?

    @Query("SELECT * FROM sales_drafts WHERE local_id = :localId")
    suspend fun findByLocalId(localId: Long): SalesDraftEntity?

    @Query("SELECT * FROM sales_draft_lines WHERE draft_local_id = :draftLocalId ORDER BY local_id")
    fun observeLines(draftLocalId: Long): Flow<List<SalesDraftLineEntity>>

    @Query("SELECT * FROM sales_draft_lines WHERE draft_local_id = :draftLocalId ORDER BY local_id")
    suspend fun linesForDraft(draftLocalId: Long): List<SalesDraftLineEntity>

    @Query("SELECT COUNT(*) FROM sales_drafts WHERE sync_state = 'draft'")
    fun observeOpenCount(): Flow<Int>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(draft: SalesDraftEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(draft: SalesDraftEntity)

    @Update
    suspend fun update(draft: SalesDraftEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertLines(lines: List<SalesDraftLineEntity>)

    @Query("DELETE FROM sales_draft_lines WHERE draft_local_id = :draftLocalId")
    suspend fun clearLines(draftLocalId: Long)

    @Query("SELECT MAX(local_id) FROM sales_drafts WHERE local_id >= :provisionalFloor")
    suspend fun maxProvisionalId(provisionalFloor: Long): Long?

    @Query("SELECT MAX(local_id) FROM sales_draft_lines WHERE local_id >= :floor")
    suspend fun maxLineProvisionalId(floor: Long): Long?

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertOutboxOp(op: OutboxOpEntity): Long

    @Transaction
    suspend fun saveDraftWithLines(draft: SalesDraftEntity, lines: List<SalesDraftLineEntity>) {
        upsert(draft)
        clearLines(draft.localId)
        if (lines.isNotEmpty()) upsertLines(lines)
    }

    @Query("UPDATE outbox_ops SET replay_proof = :proof WHERE seq = :seq")
    suspend fun updateOutboxProof(seq: Long, proof: String)

    /** ثبت سند + عملیات outbox به‌صورت اتمیک (ADR §۶.۳). */
    @Transaction
    suspend fun insertWithOutbox(draft: SalesDraftEntity, op: OutboxOpEntity): Long {
        upsert(draft)
        return insertOutboxOp(op)
    }

    /**
     * Domain write + outbox + Ed25519 proof in one transaction.
     * [sign] receives allocated seq (part of the signed envelope).
     */
    @Transaction
    suspend fun insertWithOutboxSigned(
        draft: SalesDraftEntity,
        op: OutboxOpEntity,
        sign: (seq: Long) -> String,
    ): Long {
        upsert(draft)
        val seq = insertOutboxOp(op.copy(seq = 0, replayProof = null))
        updateOutboxProof(seq, sign(seq))
        return seq
    }
}
