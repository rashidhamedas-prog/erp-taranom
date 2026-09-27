package ir.taranom.crm.sales.core.domain

import ir.taranom.crm.sales.core.model.Rial
import ir.taranom.crm.sales.core.model.SalesDraft
import ir.taranom.crm.sales.core.model.VatClass

/** ردیف از دید محاسبهٔ مالیات — همان `{product_id, sum, vat_class}` سرور. */
data class VatLine(
    val productId: Long,
    /** `row.sum` سرور: مبلغ ریالی ردیف پس از تخفیف ردیفی. */
    val lineSum: Rial,
    val vatClass: VatClass = VatClass.TAXABLE,
)

/**
 * خروجی [VatCalculator.calcDocTotals]. نام کلیدهای متناظر سرور در پرانتز آمده
 * تا fixtureهای parity یک‌به‌یک قابل مقایسه باشند.
 */
data class DocTotals(
    /** `subtotal` */
    val subtotal: Rial,
    /** `discAmt` */
    val discountAmount: Rial,
    /** `netBeforeVat` */
    val netBeforeVat: Rial,
    /** `vatAmount` */
    val vatAmount: Rial,
    /** `vatRate` — درصد */
    val vatRate: Double,
    /** `final` */
    val finalAmount: Rial,
    /** `taxableBase` */
    val taxableBase: Rial,
)

/**
 * پورت `server/lib/vat.js` (`getVatRate` / `lineVatExempt` / `calcDocTotals`).
 *
 * تفاوت با نسخهٔ Node: آن نسخه نرخ و `vat_class` را داخل تابع از دیتابیس
 * می‌خواند؛ اینجا تابع **خالص** است و نرخ/کلاس به‌عنوان ورودی می‌آید تا بشود با
 * fixture مشترک روی JVM سنجید (ADR-AND-001 §۱۲.۲). خود فرمول‌ها و ترتیب
 * گردکردن‌ها عیناً یکی است.
 */
object VatCalculator {

    /** همان fallback سرور وقتی `settings.vat_rate` نبود یا عددی نبود. */
    const val DEFAULT_VAT_RATE: Double = 10.0

    /** معادل `getVatRate(db)`: مقدار تنظیمات، و اگر عددی نبود ۱۰. */
    fun resolveVatRate(settingValue: String?): Double {
        val n = settingValue?.let { JsMath.parseFloat(it) } ?: return DEFAULT_VAT_RATE
        return if (n.isFinite()) n else DEFAULT_VAT_RATE
    }

    /** معادل `lineVatExempt(vatClass)` — فقط `exempt` و `zero-rated` معاف‌اند. */
    fun lineVatExempt(vatClass: String?): Boolean = VatClass.fromWire(vatClass).isExempt

    /**
     * جمع‌های سند با VAT روی ردیف‌های مشمول.
     *
     * @param lines ردیف‌های سند؛ `subtotal` از جمع [VatLine.lineSum] ساخته می‌شود
     *   (مثل `builtRows.subtotal` سرور) مگر [subtotalOverride] داده شود.
     * @param discountPercent درصد تخفیف سند.
     * @param discountAmountOverride تخفیف مبلغی؛ اگر داده شود **جای** درصد را
     *   می‌گیرد و منفی به صفر بسته می‌شود (همان `options.discAmt`).
     * @param vatExempt کل سند معاف (`options.vatExempt`) ⇒ نرخ و مالیات صفر.
     */
    fun calcDocTotals(
        lines: List<VatLine>,
        discountPercent: Double = 0.0,
        vatRate: Double = DEFAULT_VAT_RATE,
        discountAmountOverride: Rial? = null,
        vatExempt: Boolean = false,
        subtotalOverride: Rial? = null,
    ): DocTotals {
        val subtotal = subtotalOverride ?: lines.sumOf { it.lineSum }
        val discountAmount = discountAmountOverride
            ?.coerceAtLeast(0L)
            ?: JsMath.roundToRial(subtotal * discountPercent / 100)
        val netBeforeVat = subtotal - discountAmount

        if (vatExempt) {
            return DocTotals(
                subtotal = subtotal,
                discountAmount = discountAmount,
                netBeforeVat = netBeforeVat,
                vatAmount = 0,
                vatRate = 0.0,
                finalAmount = netBeforeVat,
                taxableBase = 0,
            )
        }

        var taxableBase = lines.filterNot { it.vatClass.isExempt }.sumOf { it.lineSum }
        if (subtotal > 0 && discountAmount > 0) {
            // تخفیف سند به نسبت روی پایهٔ مشمول سرشکن می‌شود، سپس گرد.
            taxableBase = JsMath.roundToRial(
                taxableBase * (1 - discountAmount.toDouble() / subtotal)
            )
        }
        val vatAmount = JsMath.roundToRial(taxableBase * vatRate / 100)

        return DocTotals(
            subtotal = subtotal,
            discountAmount = discountAmount,
            netBeforeVat = netBeforeVat,
            vatAmount = vatAmount,
            vatRate = vatRate,
            finalAmount = netBeforeVat + vatAmount,
            taxableBase = taxableBase,
        )
    }
}

/** ردیف‌های پیش‌نویس ⇒ ورودی محاسبهٔ مالیات. */
fun SalesDraft.vatLines(): List<VatLine> = lines.map {
    VatLine(productId = it.productId, lineSum = it.lineSum, vatClass = it.vatClass)
}

/** جمع‌های همین پیش‌نویس با نرخ داده‌شده. */
fun SalesDraft.calcTotals(vatRate: Double = VatCalculator.DEFAULT_VAT_RATE): DocTotals =
    VatCalculator.calcDocTotals(
        lines = vatLines(),
        discountPercent = discountPercent,
        vatRate = vatRate,
        discountAmountOverride = discountAmountOverride,
        vatExempt = vatExempt,
    )
