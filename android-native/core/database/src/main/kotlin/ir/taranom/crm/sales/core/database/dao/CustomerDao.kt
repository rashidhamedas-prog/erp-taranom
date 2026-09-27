package ir.taranom.crm.sales.core.database.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Update
import ir.taranom.crm.sales.core.database.entity.CustomerEntity
import ir.taranom.crm.sales.core.database.entity.OutboxOpEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface CustomerDao {

    /** دامنهٔ مالکیت سمت داده اعمال می‌شود، نه با مخفی‌کردن UI (ADR §۹). */
    @Query(
        """
        SELECT * FROM customers
        WHERE (:ownerUserId IS NULL OR owner_user_id = :ownerUserId)
        ORDER BY business_name COLLATE NOCASE
        """
    )
    fun observeScoped(ownerUserId: Long?): Flow<List<CustomerEntity>>

    @Query("SELECT COUNT(*) FROM customers")
    suspend fun countAll(): Int

    @Query("SELECT * FROM customers WHERE local_id = :localId")
    suspend fun findByLocalId(localId: Long): CustomerEntity?

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(customer: CustomerEntity)

    @Update
    suspend fun update(customer: CustomerEntity)

    /** بزرگ‌ترین شناسهٔ provisional موجود — مبنای گرفتن شناسهٔ بعدی. */
    @Query("SELECT MAX(local_id) FROM customers WHERE local_id >= :provisionalFloor")
    suspend fun maxProvisionalId(provisionalFloor: Long): Long?

    // -- زیر: درج outbox داخل همین DAO است تا @Transaction بتواند هر دو نوشتن را
    // در یک تراکنش نگه دارد. برای صف از OutboxDao استفاده شود.
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertOutboxOp(op: OutboxOpEntity): Long

    /**
     * نوشتن دامنه + ثبت outbox در **یک تراکنش**.
     *
     * این همان شکافی است که در موتور Node وجود دارد (capture بعد از commit) و
     * نباید در کلاینت بومی تکرار شود: یا هر دو ثبت می‌شوند یا هیچ‌کدام —
     * هیچ‌وقت «سند بدون outbox» (ADR §۶.۳ / §۸.۲).
     */
    @Transaction
    suspend fun insertWithOutbox(customer: CustomerEntity, op: OutboxOpEntity): Long {
        insert(customer)
        return insertOutboxOp(op)
    }

    @Transaction
    suspend fun updateWithOutbox(customer: CustomerEntity, op: OutboxOpEntity): Long {
        update(customer)
        return insertOutboxOp(op)
    }
}
