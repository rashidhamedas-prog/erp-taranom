package ir.taranom.crm.sales.core.database

import android.content.Context
import androidx.room.Room

/**
 * تک‌نمونهٔ دیتابیس برای فاز ۰. با ورود Hilt در فاز ۱ جای این provider را یک
 * `@Module` می‌گیرد؛ رفتار (بدون destructive migration) عوض نمی‌شود.
 */
object TaranomDatabaseProvider {

    @Volatile
    private var instance: TaranomSalesDatabase? = null

    fun get(context: Context): TaranomSalesDatabase =
        instance ?: synchronized(this) {
            instance ?: build(context.applicationContext).also { instance = it }
        }

    private fun build(context: Context): TaranomSalesDatabase =
        Room.databaseBuilder(
            context,
            TaranomSalesDatabase::class.java,
            TaranomSalesDatabase.FILE_NAME,
        )
            .addMigrations(*Migrations.ALL)
            // عمداً هیچ fallbackToDestructiveMigration*ای نیست: شکست migration
            // باید crash قابل تشخیص بدهد، نه پاک‌کردن بی‌صدای صف ارسال‌نشده.
            .build()
}
