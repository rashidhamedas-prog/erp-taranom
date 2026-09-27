package ir.taranom.crm.sales

import android.app.Application
import ir.taranom.crm.sales.core.database.TaranomDatabaseProvider
import ir.taranom.crm.sales.migrate.AndroidLegacySqliteSource
import ir.taranom.crm.sales.migrate.LegacyDbMigrator
import ir.taranom.crm.sales.migrate.RoomMigrationSink
import ir.taranom.crm.sales.work.BackgroundSchedulers

/**
 * نقطهٔ ورود process.
 *
 * DI: در اسکلت فاز ۰ عمداً هیچ فریم‌ورکی نیست — یک provider تک‌نمونه برای دیتابیس
 * کافی است. Hilt در فاز ۱ هم‌راستا با Now in Android اضافه می‌شود (ADR-AND-001 §۴.۲).
 */
class TaranomSalesApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        // فایل دیتابیس همین‌جا ساخته می‌شود تا مالکیت داده از اولین اجرا مشخص باشد؛
        // این cache نیست و پاک‌کردنی نیست (ADR §۱.۴).
        val db = TaranomDatabaseProvider.get(this)

        // فاز ۵: اگر crm.db legacy روی همین filesDir باشد، dry-run تشخیص اجرا می‌شود.
        // کپی واقعی فقط با تأیید UI (بدون wipe بی‌صدا).
        AndroidLegacySqliteSource.find(this)?.use { source ->
            val migrator = LegacyDbMigrator(source, RoomMigrationSink(db))
            if (migrator.detect()) {
                migrator.migrate(dryRun = true)
            }
        }

        // فاز ۴: WorkManager برای sync/update (نیاز به شبکه؛ فروش آفلاین مستقل است).
        BackgroundSchedulers.enqueueDefaults(this, centralBaseUrl = null)
    }
}
