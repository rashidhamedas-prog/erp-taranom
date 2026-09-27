package ir.taranom.crm.sales.core.model

/**
 * مشتری در دامنهٔ فروش (زیرمجموعهٔ scoped جدول `customers` سرور، نه کل ستون‌ها).
 *
 * [localId] شناسهٔ provisional است تا مرکز تأیید کند؛ [centralId] پس از تأیید پر
 * می‌شود و نگاشت local↔central حفظ می‌گردد (ADR §۶.۲).
 */
data class Customer(
    val localId: Long,
    val centralId: Long? = null,
    val businessName: String,
    val ownerName: String? = null,
    val city: String? = null,
    val phone: String? = null,
    /** `user_id`/`assigned_to` سرور — مبنای customer-scope. */
    val ownerUserId: Long? = null,
    val syncState: SyncState = SyncState.DRAFT,
    /** شمارندهٔ نسخهٔ سرور برای تشخیص ویرایش هم‌زمان (بدون LWW). */
    val version: Long = 0,
    val updatedAtEpochMs: Long = 0,
) {
    val isProvisional: Boolean get() = centralId == null && ProvisionalIds.isProvisional(localId)
}
