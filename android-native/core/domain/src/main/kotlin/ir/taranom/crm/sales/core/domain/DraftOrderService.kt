package ir.taranom.crm.sales.core.domain

import ir.taranom.crm.sales.core.model.OutboxOp
import ir.taranom.crm.sales.core.model.OutboxStatus
import ir.taranom.crm.sales.core.model.Rial

/**
 * Builds JSON bodies for outbox replay against central Express handlers.
 * Pure Kotlin (no Android/org.json) so JVM parity tests stay runnable.
 */
object DraftOrderService {
    /** Index of `invoices` in `server/sync/tables.js` SYNCABLE_TABLES (frozen). */
    const val INVOICES_TABLE_INDEX = 16

    const val PROFORMA_PATH = "/api/invoices"
    const val PROFORMA_METHOD = "POST"
    const val PROFORMA_ENTITY_TABLE = "invoices"

    data class ProformaRequest(
        val customerId: Long,
        val warehouseId: Long?,
        val note: String?,
        val discountPercent: Double,
        val discountAmount: Rial?,
        val vatExempt: Boolean,
        val lines: List<LineBuilder.InputLine>,
        val localDraftId: String,
        /** Provisional invoice id allocated for this device (tableBase + n). */
        val provisionalInvoiceId: Long,
        val userId: Long,
        val baseVersion: Long? = null,
    )

    fun buildProformaBody(req: ProformaRequest): String {
        val built = LineBuilder.buildRows(req.lines)
        val totals = VatCalculator.calcDocTotals(
            lines = LineBuilder.toVatLines(built),
            discountPercent = req.discountPercent,
            discountAmountOverride = req.discountAmount,
            vatExempt = req.vatExempt,
        )
        val rowsJson = built.rows.joinToString(prefix = "[", postfix = "]") { line ->
            """{"product_id":${line.productId},"qty":${line.qty},"price":${line.unitPrice},"disc":${line.discountAmount},"sum":${line.sum}}"""
        }
        val noteJson = req.note?.let { "\"${escapeJson(it)}\"" } ?: "null"
        val whJson = req.warehouseId?.toString() ?: "null"
        return """{"customer_id":${req.customerId},"type":"proforma","warehouse_id":$whJson,"note":$noteJson,"disc":${req.discountPercent},"disc_amt":${totals.discountAmount},"vat_exempt":${if (req.vatExempt) 1 else 0},"rows":$rowsJson,"subtotal":${totals.subtotal},"final":${totals.finalAmount},"client_draft_id":"${escapeJson(req.localDraftId)}","id":${req.provisionalInvoiceId}}"""
    }

    /**
     * Outbox op ready for Room insert (seq=0, replayProof=null).
     * Caller must [ir.taranom.crm.sales.core.database.dao.OutboxDao.insertThenSign]
     * inside the same domain write transaction.
     */
    fun buildProformaOutboxOp(req: ProformaRequest, createdAtEpochMs: Long = System.currentTimeMillis()): OutboxOp {
        val body = buildProformaBody(req)
        val captured = """{"invoices":[${req.provisionalInvoiceId}]}"""
        return OutboxOp(
            seq = 0,
            method = PROFORMA_METHOD,
            path = PROFORMA_PATH,
            bodyJson = body,
            userId = req.userId,
            baseVersion = req.baseVersion,
            entityTable = PROFORMA_ENTITY_TABLE,
            entityLocalId = req.provisionalInvoiceId,
            capturedRowsJson = captured,
            replayProof = null,
            status = OutboxStatus.PENDING,
            createdAtEpochMs = createdAtEpochMs,
        )
    }

    private fun escapeJson(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"")
}
