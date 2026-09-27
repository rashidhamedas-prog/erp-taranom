package ir.taranom.crm.sales.core.model

/**
 * سند فروش محلی محدود (پیش‌فاکتور/فاکتور) — شمارهٔ رسمی فقط از مرکز.
 */
data class InvoiceDoc(
    val localId: Long,
    val centralId: Long? = null,
    val customerLocalId: Long,
    val documentNumber: String,
    val type: String = "proforma",
    val date: String,
    val note: String? = null,
    val subtotal: Rial = 0,
    val discountAmount: Rial = 0,
    val totalAmount: Rial = 0,
    val syncState: SyncState = SyncState.DRAFT,
    val createdAtEpochMs: Long = 0,
    val updatedAtEpochMs: Long = 0,
)

data class ReceiptDoc(
    val localId: Long,
    val centralId: Long? = null,
    val customerLocalId: Long,
    val invoiceLocalId: Long? = null,
    val amount: Rial,
    val payType: String = "cash",
    val date: String,
    val note: String? = null,
    val syncState: SyncState = SyncState.DRAFT,
    val createdAtEpochMs: Long = 0,
)

data class SalesReturnDoc(
    val localId: Long,
    val centralId: Long? = null,
    val customerLocalId: Long,
    val invoiceLocalId: Long? = null,
    val documentNumber: String,
    val date: String,
    val totalAmount: Rial = 0,
    val note: String? = null,
    val syncState: SyncState = SyncState.DRAFT,
    val createdAtEpochMs: Long = 0,
)
