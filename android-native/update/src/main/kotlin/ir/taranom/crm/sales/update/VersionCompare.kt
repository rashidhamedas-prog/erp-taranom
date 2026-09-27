package ir.taranom.crm.sales.update

/**
 * مقایسهٔ نسخهٔ نقطه‌ای — همان الگوریتم `compareVersion` در `server/lib/app-update.js`.
 * بخش‌های غیرعددی → 0.
 */
object VersionCompare {

    fun parse(version: String?): List<Int> =
        (version ?: "0")
            .split(Regex("[.-]"))
            .map { it.toIntOrNull() ?: 0 }

    /** منفی = a قدیمی‌تر از b · صفر = برابر · مثبت = a جدیدتر. */
    fun compare(a: String?, b: String?): Int {
        val pa = parse(a)
        val pb = parse(b)
        val len = maxOf(pa.size, pb.size)
        for (i in 0 until len) {
            val d = (pa.getOrElse(i) { 0 }) - (pb.getOrElse(i) { 0 })
            if (d != 0) return d
        }
        return 0
    }

    fun isNewer(candidate: String?, current: String?): Boolean =
        compare(candidate, current) > 0
}
