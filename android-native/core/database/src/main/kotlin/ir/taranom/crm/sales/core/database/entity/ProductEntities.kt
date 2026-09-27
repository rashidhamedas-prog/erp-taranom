package ir.taranom.crm.sales.core.database.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import ir.taranom.crm.sales.core.model.Product
import ir.taranom.crm.sales.core.model.ProductVariant

@Entity(
    tableName = "products",
    indices = [
        Index(value = ["central_id"], unique = true),
        Index(value = ["name"]),
        Index(value = ["code"]),
    ],
)
data class ProductEntity(
    @PrimaryKey
    @ColumnInfo(name = "local_id") val localId: Long,
    @ColumnInfo(name = "central_id") val centralId: Long? = null,
    @ColumnInfo(name = "code") val code: String? = null,
    @ColumnInfo(name = "name") val name: String,
    @ColumnInfo(name = "category") val category: String? = null,
    @ColumnInfo(name = "price_rial") val priceRial: Long = 0,
    @ColumnInfo(name = "stock") val stock: Double = 0.0,
    @ColumnInfo(name = "image_path") val imagePath: String? = null,
    @ColumnInfo(name = "unit") val unit: String = "عدد",
    @ColumnInfo(name = "active") val active: Boolean = true,
    @ColumnInfo(name = "updated_at") val updatedAt: Long = 0,
)

fun ProductEntity.toDomain(): Product = Product(
    localId = localId,
    centralId = centralId,
    code = code,
    name = name,
    category = category,
    priceRial = priceRial,
    stock = stock,
    imagePath = imagePath,
    unit = unit,
    active = active,
    updatedAtEpochMs = updatedAt,
)

@Entity(
    tableName = "product_variants",
    indices = [
        Index(value = ["central_id"], unique = true),
        Index(value = ["product_local_id"]),
        Index(value = ["sku"]),
    ],
)
data class ProductVariantEntity(
    @PrimaryKey
    @ColumnInfo(name = "local_id") val localId: Long,
    @ColumnInfo(name = "central_id") val centralId: Long? = null,
    @ColumnInfo(name = "product_local_id") val productLocalId: Long,
    @ColumnInfo(name = "color_name") val colorName: String? = null,
    @ColumnInfo(name = "size_name") val sizeName: String? = null,
    @ColumnInfo(name = "sku") val sku: String? = null,
    @ColumnInfo(name = "price_rial") val priceRial: Long = 0,
    @ColumnInfo(name = "stock") val stock: Double = 0.0,
    @ColumnInfo(name = "active") val active: Boolean = true,
)

fun ProductVariantEntity.toDomain(): ProductVariant = ProductVariant(
    localId = localId,
    centralId = centralId,
    productLocalId = productLocalId,
    colorName = colorName,
    sizeName = sizeName,
    sku = sku,
    priceRial = priceRial,
    stock = stock,
    active = active,
)
