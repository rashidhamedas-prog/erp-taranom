package ir.taranom.crm.sales.core.model

/**
 * سبد/پیش‌نویس سند فروش — از روز اول در دیتابیس، **نه** در حافظه یا
 * `localStorage` (شکاف شناخته‌شدهٔ `marketer-ui.js`؛ EVIDENCE §C).
 *
 * مبالغ همه ریال صحیح؛ فقط [SalesDraftLine.qty] اعشاری ۳ رقمی است.
 */
data class SalesDraft(
    val localId: Long,
    val centralId: Long? = null,
    val customerLocalId: Long,
    /**
     * شمارهٔ سند. آفلاین همیشه `موقت-…` است؛ شمارهٔ رسمی فقط از
     * `allocateNumber()` مرکز می‌آید (ADR §۸.۱).
     */
    val documentNumber: String,
    val discountPercent: Double = 0.0,
    /** اگر کاربر تخفیف را مبلغی وارد کرده باشد؛ اولویت بر درصد دارد (مثل سرور). */
    val discountAmountOverride: Rial? = null,
    val vatExempt: Boolean = false,
    val lines: List<SalesDraftLine> = emptyList(),
    val syncState: SyncState = SyncState.DRAFT,
    val createdAtEpochMs: Long = 0,
    val updatedAtEpochMs: Long = 0,
) {
    val isTemporaryNumber: Boolean get() = documentNumber.startsWith(TEMP_NUMBER_PREFIX)

    companion object {
        /** پیشوند شمارهٔ موقت آفلاین — چاپش باید واترمارک «پیش‌نویس» داشته باشد. */
        const val TEMP_NUMBER_PREFIX = "موقت-"
    }
}

/**
 * ردیف پیش‌نویس. [lineSum] مبلغ ردیف پس از تخفیف ردیفی است — همان `row.sum`
 * سرور که مبنای پایهٔ مشمول VAT قرار می‌گیرد.
 */
data class SalesDraftLine(
    val localId: Long,
    val productId: Long,
    val productName: String,
    val qty: Qty,
    val unitPrice: Rial,
    val lineSum: Rial,
    val vatClass: VatClass = VatClass.TAXABLE,
    val variantColor: String? = null,
    val variantSize: String? = null,
)
