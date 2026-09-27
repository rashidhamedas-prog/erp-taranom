package ir.taranom.crm.sales.core.database.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import ir.taranom.crm.sales.core.model.SyncState

/**
 * سربرگ پیش‌نویس/سبد فروش. از روز اول روی دیسک است تا تماس، چرخش صفحه یا
 * kill شدن فرایند پیش‌نویس فروشنده را نبرد (ADR §۱۱ و EVIDENCE §C).
 *
 * TODO(فاز ۱): جدول `sales_draft_lines` + migration نسخهٔ ۲. در فاز ۰ فقط
 * سربرگ ذخیره می‌شود تا اسکلت با یک اسکیمای نسخهٔ ۱ پایدار بسته شود.
 */
@Entity(
    tableName = "sales_drafts",
    indices = [
        Index(value = ["central_id"], unique = true),
        Index(value = ["customer_local_id"]),
        Index(value = ["sync_state"]),
    ],
)
data class SalesDraftEntity(
    @PrimaryKey
    @ColumnInfo(name = "local_id") val localId: Long,
    @ColumnInfo(name = "central_id") val centralId: Long? = null,
    @ColumnInfo(name = "customer_local_id") val customerLocalId: Long,
    /** آفلاین همیشه `موقت-…`؛ شمارهٔ رسمی فقط از `allocateNumber()` مرکز. */
    @ColumnInfo(name = "document_number") val documentNumber: String,
    @ColumnInfo(name = "discount_percent") val discountPercent: Double = 0.0,
    @ColumnInfo(name = "discount_amount_override") val discountAmountOverride: Long? = null,
    @ColumnInfo(name = "vat_exempt") val vatExempt: Boolean = false,
    /** جمع‌های آخرین محاسبه (ریال صحیح) — مرجع همیشه محاسبهٔ مجدد دامنه است. */
    @ColumnInfo(name = "subtotal") val subtotal: Long = 0,
    @ColumnInfo(name = "discount_amount") val discountAmount: Long = 0,
    @ColumnInfo(name = "vat_amount") val vatAmount: Long = 0,
    @ColumnInfo(name = "total_amount") val totalAmount: Long = 0,
    @ColumnInfo(name = "sync_state") val syncState: String = SyncState.DRAFT.wireValue,
    @ColumnInfo(name = "created_at") val createdAt: Long = 0,
    @ColumnInfo(name = "updated_at") val updatedAt: Long = 0,
)
