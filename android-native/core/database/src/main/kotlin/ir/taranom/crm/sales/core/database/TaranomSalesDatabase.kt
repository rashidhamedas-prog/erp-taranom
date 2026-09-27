package ir.taranom.crm.sales.core.database

import androidx.room.Database
import androidx.room.RoomDatabase
import ir.taranom.crm.sales.core.database.dao.CustomerDao
import ir.taranom.crm.sales.core.database.dao.OutboxDao
import ir.taranom.crm.sales.core.database.dao.SalesDraftDao
import ir.taranom.crm.sales.core.database.entity.CustomerEntity
import ir.taranom.crm.sales.core.database.entity.OutboxOpEntity
import ir.taranom.crm.sales.core.database.entity.SalesDraftEntity

/**
 * دیتابیس محلی محصول — **منبع حقیقت دستگاه**، نه cache.
 *
 * نسخهٔ ۱ = اسکلت فاز ۰ (مشتری، پیش‌نویس فروش، صف outbox). هر تغییر اسکیما بعد
 * از این باید `Migration` نسخه‌دار داشته باشد؛ `fallbackToDestructiveMigration`
 * ممنوع است چون صف ارسال‌نشده را از بین می‌برد (`Migrations.kt`).
 */
@Database(
    entities = [
        CustomerEntity::class,
        SalesDraftEntity::class,
        OutboxOpEntity::class,
    ],
    // باید با TaranomSalesDatabase.VERSION یکی بماند (annotation فقط لیترال می‌پذیرد).
    version = 1,
    exportSchema = true,
)
abstract class TaranomSalesDatabase : RoomDatabase() {

    abstract fun customerDao(): CustomerDao
    abstract fun salesDraftDao(): SalesDraftDao
    abstract fun outboxDao(): OutboxDao

    companion object {
        const val VERSION = 1

        /**
         * نام فایل. مسیر legacy (`files/crm-data/crm.db` متعلق به nodejs-mobile)
         * عمداً دست‌نخورده می‌ماند تا migrator فاز ۵ بتواند از آن بخواند.
         */
        const val FILE_NAME = "taranom-sales.db"
    }
}
