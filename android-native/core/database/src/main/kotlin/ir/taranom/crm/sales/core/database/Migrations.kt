package ir.taranom.crm.sales.core.database

import androidx.room.migration.Migration

/**
 * سیاست migration.
 *
 * ۱. نسخه ۱ مبنا است؛ هیچ migrationی لازم نیست.
 * ۲. هر تغییر اسکیما ⇒ `VERSION + 1` و یک [Migration] صریح در [ALL].
 * ۳. **`fallbackToDestructiveMigration` هرگز.** پاک‌شدن دیتابیس یعنی از دست
 *    رفتن صف `pending` — یعنی سندی که فروشنده ثبت کرده و مرکز هنوز ندیده.
 *    (ADR-AND-001 §۶.۴ / §۸.۲ و §۱۰: «حفظ draft/DB/outbox» در ارتقا.)
 * ۴. اسکیمای صادرشده در `core/database/schemas/` کامیت می‌شود تا هر migration
 *    قابل بازبینی مستقل باشد.
 */
internal object Migrations {
    val ALL: Array<Migration> = emptyArray()
}
