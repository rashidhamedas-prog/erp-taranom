package ir.taranom.crm.sales

import android.app.Application
import ir.taranom.crm.sales.core.database.TaranomDatabaseProvider

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
        TaranomDatabaseProvider.get(this)
    }
}
