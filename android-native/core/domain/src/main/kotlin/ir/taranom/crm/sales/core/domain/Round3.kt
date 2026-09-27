package ir.taranom.crm.sales.core.domain

import ir.taranom.crm.sales.core.model.Qty
import java.math.BigDecimal
import java.math.RoundingMode

/**
 * پورت `server/lib/round3.js` (Update 11 / D1).
 *
 * قاعده: **مبلغ همیشه ریال صحیح است؛ فقط qty/موجودی اعشاری با ۳ رقم گرد می‌شود.**
 * مرجع parity = سرور؛ هر تغییر اینجا باید با همان فایل Node هم‌زمان شود.
 */
object Round3 {

    /** `round3(n)` — گرد کردن مقدار به ۳ رقم اعشار. ورودی نامعتبر ⇒ `0`. */
    fun round3(n: Double?): Qty {
        val x = n ?: return 0.0
        if (!x.isFinite()) return 0.0
        return JsMath.round(x * 1000) / 1000
    }

    /**
     * `parseQty(v, fallback)` — تبدیل ورودی کاربر/API به qty گردشده.
     * هرگز `parseInt`: «۲٫۵ متر» باید ۲٫۵ بماند. جداکنندهٔ هزار (`,`) حذف می‌شود.
     */
    fun parseQty(v: String?, fallback: Double = 0.0): Qty {
        if (v == null || v.isEmpty()) return round3(fallback)
        val x = JsMath.parseFloat(v.replace(",", ""))
        if (!x.isFinite()) return round3(fallback)
        return round3(x)
    }

    /** نمایش qty: تا ۳ رقم اعشار، صفرهای انتهایی حذف. */
    fun fmtQty(n: Double?): String {
        val x = round3(n)
        // `-0.0 == 0.0` در Kotlin برابر است، پس حالت منفی‌صفر سرور هم پوشش دارد.
        if (x == 0.0) return "0"
        return BigDecimal(x)
            .setScale(3, RoundingMode.HALF_UP)
            .stripTrailingZeros()
            .toPlainString()
    }
}
