package ir.taranom.crm.sales.core.domain

import kotlin.math.floor

/**
 * هم‌ارزهای دقیق چند عملگر عددی JavaScript.
 *
 * چرا لازم است: سرور مرجع محاسبات مالی است و با Node اجرا می‌شود. اگر Kotlin از
 * `kotlin.math.round` استفاده کند نتیجه در حالت تساوی **متفاوت** می‌شود
 * (`kotlin.math.round` ties-to-even است، `Math.round` جاوااسکریپت ties-toward-+∞).
 * مثال واقعی: مالیات ۱۰٪ روی ۱۰۵ ریال = ۱۰٫۵ ⇒ سرور ۱۱، ties-to-even ۱۰.
 */
internal object JsMath {

    /**
     * معادل `Math.round(x)` در ECMAScript — از جمله نتیجهٔ `-0` برای
     * `-0.5 ≤ x < 0` که در `round3` سرور قابل مشاهده است.
     */
    fun round(x: Double): Double {
        if (x.isNaN()) return Double.NaN
        if (x == 0.0 || x.isInfinite()) return x
        if (x < 0.0 && x >= -0.5) return -0.0
        return floor(x + 0.5)
    }

    /** `Math.round` روی مبالغ ریالی صحیح. */
    fun roundToRial(x: Double): Long {
        val r = round(x)
        return if (r.isNaN()) 0L else r.toLong()
    }

    private val LEADING_NUMBER =
        Regex("""^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?""")

    /**
     * معادل `parseFloat(s)`: فاصلهٔ ابتدایی نادیده گرفته می‌شود، پیشوند عددی
     * خوانده می‌شود و بقیهٔ رشته دور ریخته می‌شود (`"12abc"` ⇒ `12.0`).
     * ورودی بی‌عدد ⇒ `NaN` (مثل JS، نه استثنا مثل `toDouble()`).
     */
    fun parseFloat(s: String): Double {
        val t = s.trimStart()
        if (t.startsWith("Infinity") || t.startsWith("+Infinity")) return Double.POSITIVE_INFINITY
        if (t.startsWith("-Infinity")) return Double.NEGATIVE_INFINITY
        val m = LEADING_NUMBER.find(t) ?: return Double.NaN
        return m.value.toDoubleOrNull() ?: Double.NaN
    }
}
