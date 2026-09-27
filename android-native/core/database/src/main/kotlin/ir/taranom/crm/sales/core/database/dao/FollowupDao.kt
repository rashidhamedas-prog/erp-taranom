package ir.taranom.crm.sales.core.database.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import ir.taranom.crm.sales.core.database.entity.FollowupEntity
import ir.taranom.crm.sales.core.database.entity.OutboxOpEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface FollowupDao {
    @Query("SELECT * FROM followups ORDER BY date DESC, created_at DESC")
    fun observeAll(): Flow<List<FollowupEntity>>

    @Query("SELECT * FROM followups WHERE date = :date ORDER BY priority DESC, created_at DESC")
    fun observeForDate(date: String): Flow<List<FollowupEntity>>

    @Query("SELECT * FROM followups WHERE status = 'open' ORDER BY date ASC")
    fun observeOpen(): Flow<List<FollowupEntity>>

    @Query("SELECT COUNT(*) FROM followups WHERE status = 'open'")
    fun observeOpenCount(): Flow<Int>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(followup: FollowupEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertOutboxOp(op: OutboxOpEntity): Long

    @Query("SELECT MAX(local_id) FROM followups WHERE local_id >= :floor")
    suspend fun maxProvisionalId(floor: Long): Long?

    @Transaction
    suspend fun insertWithOutbox(followup: FollowupEntity, op: OutboxOpEntity): Long {
        upsert(followup)
        return insertOutboxOp(op)
    }
}
