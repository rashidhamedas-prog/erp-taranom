package ir.taranom.crm.sales.core.domain

import ir.taranom.crm.sales.core.model.VatClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LineBuilderTest {
    @Test
    fun discountAmountBeatsPercent() {
        val built = LineBuilder.buildRows(
            listOf(
                LineBuilder.InputLine(
                    productId = 1,
                    qty = 2,
                    unitPrice = 100_000,
                    discountAmount = 10_000,
                    discountPercent = 50.0, // must be ignored when amount present
                ),
            ),
        )
        assertEquals(190_000L, built.subtotal)
        assertEquals(10_000L, built.rows.single().discountAmount)
    }

    @Test
    fun percentDiscountWhenNoAmount() {
        val built = LineBuilder.buildRows(
            listOf(
                LineBuilder.InputLine(
                    productId = 1,
                    qty = 1,
                    unitPrice = 200_000,
                    discountPercent = 10.0,
                ),
            ),
        )
        assertEquals(180_000L, built.subtotal)
    }

    @Test
    fun customerScopeOwnerOrAssignee() {
        assertTrue(CustomerScope.visibleTo(5, 5, null))
        assertTrue(CustomerScope.visibleTo(5, 9, 5))
        assertFalse(CustomerScope.visibleTo(5, 9, 8))
    }

    @Test
    fun vatOnBuiltRows() {
        val built = LineBuilder.buildRows(
            listOf(
                LineBuilder.InputLine(1, 1, 105, vatClass = VatClass.TAXABLE),
            ),
        )
        val totals = VatCalculator.calcDocTotals(
            lines = LineBuilder.toVatLines(built),
            vatRate = 10.0,
        )
        // 10% of 105 = 10.5 → JS round → 11
        assertEquals(11L, totals.vatAmount)
        assertEquals(116L, totals.finalAmount)
    }
}
