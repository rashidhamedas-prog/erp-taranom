package ir.taranom.crm.sales.core.database.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import ir.taranom.crm.sales.core.database.entity.CallLogEntity
import ir.taranom.crm.sales.core.database.entity.OutboxOpEntity
import ir.taranom.crm.sales.core.database.entity.VisitLogEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface VisitLogDao {
    @Query("SELECT * FROM visit_logs ORDER BY created_at DESC")
    fun observeAll(): Flow<List<VisitLogEntity>>

    @Query("SELECT COUNT(*) FROM visit_logs")
    fun observeCount(): Flow<Int>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(visit: VisitLogEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertOutboxOp(op: OutboxOpEntity): Long

    @Query("SELECT MAX(local_id) FROM visit_logs WHERE local_id >= :floor")
    suspend fun maxProvisionalId(floor: Long): Long?

    @Transaction
    suspend fun insertWithOutbox(visit: VisitLogEntity, op: OutboxOpEntity): Long {
        upsert(visit)
        return insertOutboxOp(op)
    }
}

@Dao
interface CallLogDao {
    @Query("SELECT * FROM call_logs ORDER BY created_at DESC")
    fun observeAll(): Flow<List<CallLogEntity>>

    @Query("SELECT COUNT(*) FROM call_logs")
    fun observeCount(): Flow<Int>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(call: CallLogEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertOutboxOp(op: OutboxOpEntity): Long

    @Query("SELECT MAX(local_id) FROM call_logs WHERE local_id >= :floor")
    suspend fun maxProvisionalId(floor: Long): Long?

    @Transaction
    suspend fun insertWithOutbox(call: CallLogEntity, op: OutboxOpEntity): Long {
        upsert(call)
        return insertOutboxOp(op)
    }
}
