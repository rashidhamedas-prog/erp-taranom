package ir.taranom.crm.sales.core.domain

import ir.taranom.crm.sales.core.model.VatClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * fixtureهای طلایی VAT — همهٔ مقادیر انتظاری با اجرای `calcDocTotals` واقعی از
 * `server/lib/vat.js` روی Node تولید شده‌اند (نرخ و `vat_class` از db استاب).
 * این تست‌ها قرارداد parity هستند: شکستن‌شان یعنی موبایل و سرور دیگر یک عدد
 * نمی‌دهند.
 */
class VatCalculatorTest {

    private fun taxable(id: Long, sum: Long) = VatLine(id, sum, VatClass.TAXABLE)
    private fun exempt(id: Long, sum: Long) = VatLine(id, sum, VatClass.EXEMPT)

    @Test
    fun `F1 all taxable no discount rate 10`() {
        val t = VatCalculator.calcDocTotals(
            lines = listOf(taxable(1, 600_000), taxable(2, 400_000)),
            discountPercent = 0.0,
            vatRate = 10.0,
        )
        assertEquals(1_000_000L, t.subtotal)
        assertEquals(0L, t.discountAmount)
        assertEquals(1_000_000L, t.netBeforeVat)
        assertEquals(100_000L, t.vatAmount)
        assertEquals(1_100_000L, t.finalAmount)
        assertEquals(1_000_000L, t.taxableBase)
    }

    @Test
    fun `F2 percent discount rounds half up then scales base`() {
        val t = VatCalculator.calcDocTotals(
            lines = listOf(taxable(1, 1_234_567)),
            discountPercent = 7.0,
            vatRate = 9.0,
        )
        assertEquals(86_420L, t.discountAmount)
        assertEquals(1_148_147L, t.netBeforeVat)
        assertEquals(1_148_147L, t.taxableBase)
        assertEquals(103_333L, t.vatAmount)
        assertEquals(1_251_480L, t.finalAmount)
    }

    @Test
    fun `F3 exempt line stays out of taxable base`() {
        val t = VatCalculator.calcDocTotals(
            lines = listOf(taxable(1, 700_000), exempt(2, 300_000)),
            discountPercent = 10.0,
            vatRate = 10.0,
        )
        assertEquals(100_000L, t.discountAmount)
        assertEquals(900_000L, t.netBeforeVat)
        assertEquals(630_000L, t.taxableBase)
        assertEquals(63_000L, t.vatAmount)
        assertEquals(963_000L, t.finalAmount)
    }

    @Test
    fun `F4 amount override wins over percent`() {
        val t = VatCalculator.calcDocTotals(
            lines = listOf(taxable(1, 500_000)),
            discountPercent = 50.0,
            vatRate = 10.0,
            discountAmountOverride = 123_456,
        )
        assertEquals(123_456L, t.discountAmount)
        assertEquals(376_544L, t.netBeforeVat)
        assertEquals(376_544L, t.taxableBase)
        assertEquals(37_654L, t.vatAmount)
        assertEquals(414_198L, t.finalAmount)
    }

    @Test
    fun `F5 document level exemption zeroes rate and base`() {
        val t = VatCalculator.calcDocTotals(
            lines = listOf(taxable(1, 777_777)),
            discountPercent = 5.0,
            vatRate = 10.0,
            vatExempt = true,
        )
        assertEquals(38_889L, t.discountAmount)
        assertEquals(738_888L, t.netBeforeVat)
        assertEquals(0L, t.vatAmount)
        assertEquals(0.0, t.vatRate, 0.0)
        assertEquals(0L, t.taxableBase)
        assertEquals(738_888L, t.finalAmount)
    }

    @Test
    fun `F6 zero rated line with rate override`() {
        val t = VatCalculator.calcDocTotals(
            lines = listOf(VatLine(1, 250_000, VatClass.ZERO_RATED)),
            discountPercent = 0.0,
            vatRate = 0.0,
        )
        assertEquals(250_000L, t.netBeforeVat)
        assertEquals(0L, t.taxableBase)
        assertEquals(0L, t.vatAmount)
        assertEquals(250_000L, t.finalAmount)
    }

    /** ۱۰٪ از ۱۰۵ = ۱۰٫۵ ⇒ سرور ۱۱ می‌دهد (ties-to-even می‌داد ۱۰). */
    @Test
    fun `F7 vat tie rounds up like node`() {
        val t = VatCalculator.calcDocTotals(
            lines = listOf(taxable(1, 105)),
            vatRate = 10.0,
        )
        assertEquals(11L, t.vatAmount)
        assertEquals(116L, t.finalAmount)
    }

    @Test
    fun `F8 fractional percent with mixed exemption`() {
        val t = VatCalculator.calcDocTotals(
            lines = listOf(taxable(1, 111_111), exempt(3, 222_222)),
            discountPercent = 3.5,
            vatRate = 10.0,
        )
        assertEquals(333_333L, t.subtotal)
        assertEquals(11_667L, t.discountAmount)
        assertEquals(321_666L, t.netBeforeVat)
        assertEquals(107_222L, t.taxableBase)
        assertEquals(10_722L, t.vatAmount)
        assertEquals(332_388L, t.finalAmount)
    }

    @Test
    fun `F9 negative amount override clamps to zero`() {
        val t = VatCalculator.calcDocTotals(
            lines = listOf(taxable(1, 100_000)),
            vatRate = 10.0,
            discountAmountOverride = -5_000,
        )
        assertEquals(0L, t.discountAmount)
        assertEquals(110_000L, t.finalAmount)
    }

    @Test
    fun `F10 missing vat_rate setting falls back to ten`() {
        assertEquals(10.0, VatCalculator.resolveVatRate(null), 0.0)
        assertEquals(10.0, VatCalculator.resolveVatRate("oops"), 0.0)
        assertEquals(9.0, VatCalculator.resolveVatRate("9"), 0.0)

        val t = VatCalculator.calcDocTotals(lines = listOf(taxable(1, 1_000)))
        assertEquals(100L, t.vatAmount)
        assertEquals(1_100L, t.finalAmount)
    }

    @Test
    fun `X1 fully exempt document still takes the discount`() {
        val t = VatCalculator.calcDocTotals(
            lines = listOf(exempt(1, 300_000), VatLine(2, 200_000, VatClass.ZERO_RATED)),
            discountPercent = 12.5,
            vatRate = 10.0,
        )
        assertEquals(62_500L, t.discountAmount)
        assertEquals(437_500L, t.netBeforeVat)
        assertEquals(0L, t.taxableBase)
        assertEquals(437_500L, t.finalAmount)
    }

    @Test
    fun `X2 hundred percent discount zeroes everything`() {
        val t = VatCalculator.calcDocTotals(
            lines = listOf(taxable(1, 999_999)),
            discountPercent = 100.0,
            vatRate = 10.0,
        )
        assertEquals(999_999L, t.discountAmount)
        assertEquals(0L, t.netBeforeVat)
        assertEquals(0L, t.taxableBase)
        assertEquals(0L, t.finalAmount)
    }

    /**
     * سرور تخفیف بزرگ‌تر از جمع را **نمی‌بندد** و نتیجه منفی می‌شود. اینجا هم
     * عیناً همان رفتار قفل شده تا اگر روزی سیاست عوض شد، هر دو طرف با هم عوض
     * شوند (اعتبارسنجی ورودی جای دیگری است، نه در گردکردن).
     */
    @Test
    fun `X4 discount larger than subtotal goes negative like node`() {
        val t = VatCalculator.calcDocTotals(
            lines = listOf(taxable(1, 1_000)),
            vatRate = 10.0,
            discountAmountOverride = 5_000,
        )
        assertEquals(5_000L, t.discountAmount)
        assertEquals(-4_000L, t.netBeforeVat)
        assertEquals(-4_000L, t.taxableBase)
        assertEquals(-400L, t.vatAmount)
        assertEquals(-4_400L, t.finalAmount)
    }

    @Test
    fun `lineVatExempt matches node`() {
        assertTrue(VatCalculator.lineVatExempt("exempt"))
        assertTrue(VatCalculator.lineVatExempt("zero-rated"))
        assertFalse(VatCalculator.lineVatExempt("taxable"))
        assertFalse(VatCalculator.lineVatExempt(null))
        assertFalse(VatCalculator.lineVatExempt(""))
    }
}
