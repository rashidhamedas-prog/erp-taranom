package ir.taranom.crm.sales.core.database

import androidx.room.Database
import androidx.room.RoomDatabase
import ir.taranom.crm.sales.core.database.dao.CallLogDao
import ir.taranom.crm.sales.core.database.dao.CustomerDao
import ir.taranom.crm.sales.core.database.dao.FollowupDao
import ir.taranom.crm.sales.core.database.dao.InvoiceDao
import ir.taranom.crm.sales.core.database.dao.OutboxDao
import ir.taranom.crm.sales.core.database.dao.ProductDao
import ir.taranom.crm.sales.core.database.dao.ProductVariantDao
import ir.taranom.crm.sales.core.database.dao.ReceiptDao
import ir.taranom.crm.sales.core.database.dao.SalesDraftDao
import ir.taranom.crm.sales.core.database.dao.SalesReturnDao
import ir.taranom.crm.sales.core.database.dao.SyncConflictDao
import ir.taranom.crm.sales.core.database.dao.VisitLogDao
import ir.taranom.crm.sales.core.database.entity.CallLogEntity
import ir.taranom.crm.sales.core.database.entity.CustomerEntity
import ir.taranom.crm.sales.core.database.entity.FollowupEntity
import ir.taranom.crm.sales.core.database.entity.InvoiceEntity
import ir.taranom.crm.sales.core.database.entity.OutboxOpEntity
import ir.taranom.crm.sales.core.database.entity.ProductEntity
import ir.taranom.crm.sales.core.database.entity.ProductVariantEntity
import ir.taranom.crm.sales.core.database.entity.ReceiptEntity
import ir.taranom.crm.sales.core.database.entity.SalesDraftEntity
import ir.taranom.crm.sales.core.database.entity.SalesDraftLineEntity
import ir.taranom.crm.sales.core.database.entity.SalesReturnEntity
import ir.taranom.crm.sales.core.database.entity.SyncConflictEntity
import ir.taranom.crm.sales.core.database.entity.VisitLogEntity

/**
 * دیتابیس محلی محصول — **منبع حقیقت دستگاه**، نه cache.
 *
 * نسخهٔ ۲ = فاز ۲/۳ (پیگیری، ویزیت/تماس، کاتالوگ، خطوط پیش‌نویس، اسناد مالی محدود، تعارض).
 * `fallbackToDestructiveMigration` ممنوع است (`Migrations.kt`).
 */
@Database(
    entities = [
        CustomerEntity::class,
        SalesDraftEntity::class,
        SalesDraftLineEntity::class,
        OutboxOpEntity::class,
        FollowupEntity::class,
        VisitLogEntity::class,
        CallLogEntity::class,
        ProductEntity::class,
        ProductVariantEntity::class,
        InvoiceEntity::class,
        ReceiptEntity::class,
        SalesReturnEntity::class,
        SyncConflictEntity::class,
    ],
    // باید با TaranomSalesDatabase.VERSION یکی بماند (annotation فقط لیترال می‌پذیرد).
    version = 2,
    exportSchema = true,
)
abstract class TaranomSalesDatabase : RoomDatabase() {

    abstract fun customerDao(): CustomerDao
    abstract fun salesDraftDao(): SalesDraftDao
    abstract fun outboxDao(): OutboxDao
    abstract fun followupDao(): FollowupDao
    abstract fun visitLogDao(): VisitLogDao
    abstract fun callLogDao(): CallLogDao
    abstract fun productDao(): ProductDao
    abstract fun productVariantDao(): ProductVariantDao
    abstract fun invoiceDao(): InvoiceDao
    abstract fun receiptDao(): ReceiptDao
    abstract fun salesReturnDao(): SalesReturnDao
    abstract fun syncConflictDao(): SyncConflictDao

    companion object {
        const val VERSION = 2

        /**
         * نام فایل. مسیر legacy (`files/crm-data/crm.db` متعلق به nodejs-mobile)
         * عمداً دست‌نخورده می‌ماند تا migrator فاز ۵ بتواند از آن بخواند.
         */
        const val FILE_NAME = "taranom-sales.db"
    }
}
