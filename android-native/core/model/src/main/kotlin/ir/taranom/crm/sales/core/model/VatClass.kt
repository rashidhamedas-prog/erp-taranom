package ir.taranom.crm.sales.core.model

/**
 * کلاس مالیاتی کالا — همان مقادیر ستون `products.vat_class` در سرور.
 * مقدار ناشناخته/خالی ⇒ مشمول (`TAXABLE`)، دقیقاً مثل `lineVatExempt()` در
 * `server/lib/vat.js` که فقط `exempt` و `zero-rated` را معاف می‌داند.
 */
enum class VatClass(val wireValue: String) {
    TAXABLE("taxable"),
    EXEMPT("exempt"),
    ZERO_RATED("zero-rated"),
    ;

    val isExempt: Boolean get() = this == EXEMPT || this == ZERO_RATED

    companion object {
        fun fromWire(value: String?): VatClass = when (value) {
            EXEMPT.wireValue -> EXEMPT
            ZERO_RATED.wireValue -> ZERO_RATED
            else -> TAXABLE
        }
    }
}
