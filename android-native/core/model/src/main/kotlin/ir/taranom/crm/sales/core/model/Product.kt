package ir.taranom.crm.sales.core.model

data class Product(
    val localId: Long,
    val centralId: Long? = null,
    val code: String? = null,
    val name: String,
    val category: String? = null,
    val priceRial: Rial = 0,
    val stock: Double = 0.0,
    val imagePath: String? = null,
    val unit: String = "عدد",
    val active: Boolean = true,
    val updatedAtEpochMs: Long = 0,
)

data class ProductVariant(
    val localId: Long,
    val centralId: Long? = null,
    val productLocalId: Long,
    val colorName: String? = null,
    val sizeName: String? = null,
    val sku: String? = null,
    val priceRial: Rial = 0,
    val stock: Double = 0.0,
    val active: Boolean = true,
)
