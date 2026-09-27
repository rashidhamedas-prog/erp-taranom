package ir.taranom.crm.sales.core.domain

import ir.taranom.crm.sales.core.model.ProvisionalIds
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DraftOrderServiceTest {

    @Test
    fun `proforma outbox op targets invoices wire path`() {
        val provisional = ProvisionalIds.tableBase(1, DraftOrderService.INVOICES_TABLE_INDEX)
        val op = DraftOrderService.buildProformaOutboxOp(
            DraftOrderService.ProformaRequest(
                customerId = 10,
                warehouseId = 1,
                note = null,
                discountPercent = 0.0,
                discountAmount = null,
                vatExempt = false,
                lines = listOf(LineBuilder.InputLine(productId = 1, qty = 2.0, unitPrice = 50_000L)),
                localDraftId = "d1",
                provisionalInvoiceId = provisional,
                userId = 7,
            ),
        )
        assertEquals(DraftOrderService.PROFORMA_PATH, op.path)
        assertEquals(DraftOrderService.PROFORMA_METHOD, op.method)
        assertEquals("invoices", op.entityTable)
        assertEquals(provisional, op.entityLocalId)
        assertEquals(7, op.userId)
        assertTrue(op.bodyJson.contains("\"type\":\"proforma\""))
        assertTrue(op.capturedRowsJson!!.contains(provisional.toString()))
    }
}
