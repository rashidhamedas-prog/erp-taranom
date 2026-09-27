package ir.taranom.crm.sales.core.model

/**
 * تقسیم فضای شناسه بین مرکز و دستگاه‌ها — **پورت بایت‌به‌بایت** از
 * `server/sync/tables.js` (`tableBase` / `isProvisionalId`).
 *
 * این اعداد **یخ‌زده** هستند: دستگاه‌های فعلی قبلاً با همین فرمول شناسه ساخته‌اند.
 * تغییر هر ثابت = تصادم شناسه بین دستگاه‌ها (docs/architecture/NATIVE-ANDROID-EVIDENCE.md §B).
 */
object ProvisionalIds {
    const val PROVISIONAL_FLOOR: Long = 1_000_000_000_000L
    const val DEVICE_SPAN: Long = 100_000_000L
    const val TABLE_SPAN: Long = 1_000_000L
    const val LEGACY_TABLE_SLOTS: Int = 100
    const val OVERFLOW_FLOOR: Long = PROVISIONAL_FLOOR + 10_000_000_000L // 1.01e13

    /** اولین شناسهٔ مجاز برای جدول [tableIndex] روی دستگاه [deviceId]. */
    fun tableBase(deviceId: Long, tableIndex: Int): Long =
        if (tableIndex < LEGACY_TABLE_SLOTS) {
            PROVISIONAL_FLOOR + deviceId * DEVICE_SPAN + tableIndex * TABLE_SPAN
        } else {
            OVERFLOW_FLOOR + deviceId * DEVICE_SPAN + (tableIndex - LEGACY_TABLE_SLOTS) * TABLE_SPAN
        }

    /** آیا این شناسه محلی (تأییدنشده) است؟ شناسه‌های مرکز کوچک می‌مانند. */
    fun isProvisional(id: Long): Boolean = id >= PROVISIONAL_FLOOR
}
