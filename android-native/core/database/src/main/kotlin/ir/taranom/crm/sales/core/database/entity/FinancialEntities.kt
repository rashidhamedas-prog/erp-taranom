package ir.taranom.crm.sales.core.database.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import ir.taranom.crm.sales.core.model.InvoiceDoc
import ir.taranom.crm.sales.core.model.ReceiptDoc
import ir.taranom.crm.sales.core.model.SalesReturnDoc
import ir.taranom.crm.sales.core.model.SyncState

@Entity(
    tableName = "invoices",
    indices = [
        Index(value = ["central_id"], unique = true),
        Index(value = ["customer_local_id"]),
        Index(value = ["sync_state"]),
    ],
)
data class InvoiceEntity(
    @PrimaryKey
    @ColumnInfo(name = "local_id") val localId: Long,
    @ColumnInfo(name = "central_id") val centralId: Long? = null,
    @ColumnInfo(name = "customer_local_id") val customerLocalId: Long,
    @ColumnInfo(name = "document_number") val documentNumber: String,
    @ColumnInfo(name = "type") val type: String = "proforma",
    @ColumnInfo(name = "date") val date: String,
    @ColumnInfo(name = "note") val note: String? = null,
    @ColumnInfo(name = "subtotal") val subtotal: Long = 0,
    @ColumnInfo(name = "discount_amount") val discountAmount: Long = 0,
    @ColumnInfo(name = "total_amount") val totalAmount: Long = 0,
    @ColumnInfo(name = "sync_state") val syncState: String = SyncState.DRAFT.wireValue,
    @ColumnInfo(name = "created_at") val createdAt: Long = 0,
    @ColumnInfo(name = "updated_at") val updatedAt: Long = 0,
)

fun InvoiceEntity.toDomain(): InvoiceDoc = InvoiceDoc(
    localId = localId,
    centralId = centralId,
    customerLocalId = customerLocalId,
    documentNumber = documentNumber,
    type = type,
    date = date,
    note = note,
    subtotal = subtotal,
    discountAmount = discountAmount,
    totalAmount = totalAmount,
    syncState = SyncState.fromWire(syncState),
    createdAtEpochMs = createdAt,
    updatedAtEpochMs = updatedAt,
)

@Entity(
    tableName = "receipts",
    indices = [
        Index(value = ["central_id"], unique = true),
        Index(value = ["customer_local_id"]),
    ],
)
data class ReceiptEntity(
    @PrimaryKey
    @ColumnInfo(name = "local_id") val localId: Long,
    @ColumnInfo(name = "central_id") val centralId: Long? = null,
    @ColumnInfo(name = "customer_local_id") val customerLocalId: Long,
    @ColumnInfo(name = "invoice_local_id") val invoiceLocalId: Long? = null,
    @ColumnInfo(name = "amount") val amount: Long,
    @ColumnInfo(name = "pay_type") val payType: String = "cash",
    @ColumnInfo(name = "date") val date: String,
    @ColumnInfo(name = "note") val note: String? = null,
    @ColumnInfo(name = "sync_state") val syncState: String = SyncState.DRAFT.wireValue,
    @ColumnInfo(name = "created_at") val createdAt: Long = 0,
)

fun ReceiptEntity.toDomain(): ReceiptDoc = ReceiptDoc(
    localId = localId,
    centralId = centralId,
    customerLocalId = customerLocalId,
    invoiceLocalId = invoiceLocalId,
    amount = amount,
    payType = payType,
    date = date,
    note = note,
    syncState = SyncState.fromWire(syncState),
    createdAtEpochMs = createdAt,
)

@Entity(
    tableName = "sales_returns",
    indices = [
        Index(value = ["central_id"], unique = true),
        Index(value = ["customer_local_id"]),
    ],
)
data class SalesReturnEntity(
    @PrimaryKey
    @ColumnInfo(name = "local_id") val localId: Long,
    @ColumnInfo(name = "central_id") val centralId: Long? = null,
    @ColumnInfo(name = "customer_local_id") val customerLocalId: Long,
    @ColumnInfo(name = "invoice_local_id") val invoiceLocalId: Long? = null,
    @ColumnInfo(name = "document_number") val documentNumber: String,
    @ColumnInfo(name = "date") val date: String,
    @ColumnInfo(name = "total_amount") val totalAmount: Long = 0,
    @ColumnInfo(name = "note") val note: String? = null,
    @ColumnInfo(name = "sync_state") val syncState: String = SyncState.DRAFT.wireValue,
    @ColumnInfo(name = "created_at") val createdAt: Long = 0,
)

fun SalesReturnEntity.toDomain(): SalesReturnDoc = SalesReturnDoc(
    localId = localId,
    centralId = centralId,
    customerLocalId = customerLocalId,
    invoiceLocalId = invoiceLocalId,
    documentNumber = documentNumber,
    date = date,
    totalAmount = totalAmount,
    note = note,
    syncState = SyncState.fromWire(syncState),
    createdAtEpochMs = createdAt,
)

/**
 * تعارض پرچم‌خورده از pull/push — جدا از وضعیت `outbox_ops.status=conflict`.
 */
@Entity(
    tableName = "sync_conflicts",
    indices = [Index(value = ["created_at"]), Index(value = ["resolved"])],
)
data class SyncConflictEntity(
    @PrimaryKey(autoGenerate = true)
    @ColumnInfo(name = "id") val id: Long = 0,
    @ColumnInfo(name = "entity_table") val entityTable: String,
    @ColumnInfo(name = "entity_local_id") val entityLocalId: Long? = null,
    @ColumnInfo(name = "outbox_seq") val outboxSeq: Long? = null,
    @ColumnInfo(name = "message") val message: String,
    @ColumnInfo(name = "resolved") val resolved: Boolean = false,
    @ColumnInfo(name = "created_at") val createdAt: Long = 0,
)

@Entity(
    tableName = "sales_draft_lines",
    indices = [Index(value = ["draft_local_id"])],
)
data class SalesDraftLineEntity(
    @PrimaryKey
    @ColumnInfo(name = "local_id") val localId: Long,
    @ColumnInfo(name = "draft_local_id") val draftLocalId: Long,
    @ColumnInfo(name = "product_local_id") val productLocalId: Long,
    @ColumnInfo(name = "product_name") val productName: String,
    @ColumnInfo(name = "qty") val qty: Double,
    @ColumnInfo(name = "unit_price") val unitPrice: Long,
    @ColumnInfo(name = "line_sum") val lineSum: Long,
    @ColumnInfo(name = "variant_color") val variantColor: String? = null,
    @ColumnInfo(name = "variant_size") val variantSize: String? = null,
    @ColumnInfo(name = "variant_local_id") val variantLocalId: Long? = null,
)
