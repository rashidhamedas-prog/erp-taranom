package ir.taranom.crm.sales.core.database.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import ir.taranom.crm.sales.core.database.entity.ProductEntity
import ir.taranom.crm.sales.core.database.entity.ProductVariantEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface ProductDao {
    @Query("SELECT * FROM products WHERE active = 1 ORDER BY name COLLATE NOCASE")
    fun observeActive(): Flow<List<ProductEntity>>

    @Query(
        """
        SELECT * FROM products
        WHERE active = 1 AND (
          :q = '' OR name LIKE '%' || :q || '%' OR IFNULL(code,'') LIKE '%' || :q || '%'
        )
        ORDER BY name COLLATE NOCASE
        """
    )
    fun observeSearch(q: String): Flow<List<ProductEntity>>

    @Query("SELECT * FROM products WHERE local_id = :localId")
    suspend fun findByLocalId(localId: Long): ProductEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(products: List<ProductEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(product: ProductEntity)

    @Query("SELECT COUNT(*) FROM products WHERE active = 1")
    fun observeActiveCount(): Flow<Int>
}

@Dao
interface ProductVariantDao {
    @Query(
        """
        SELECT * FROM product_variants
        WHERE product_local_id = :productLocalId AND active = 1
        ORDER BY color_name, size_name
        """
    )
    fun observeForProduct(productLocalId: Long): Flow<List<ProductVariantEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(variants: List<ProductVariantEntity>)
}
