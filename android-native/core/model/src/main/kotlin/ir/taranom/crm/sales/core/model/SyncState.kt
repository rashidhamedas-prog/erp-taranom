package ir.taranom.crm.sales.core.model

/**
 * چرخهٔ حیات سند/عملیات روی دستگاه — ADR-AND-001 §۶.۱:
 * `draft → local_committed → pending_push → accepted_central | needs_attention | rejected → amended | voided`
 *
 * نکتهٔ سیاست: رد شدن در مرکز **هرگز** سند محلی را بی‌صدا حذف نمی‌کند.
 */
enum class SyncState(val wireValue: String) {
    DRAFT("draft"),
    LOCAL_COMMITTED("local_committed"),
    PENDING_PUSH("pending_push"),
    ACCEPTED_CENTRAL("accepted_central"),
    NEEDS_ATTENTION("needs_attention"),
    REJECTED("rejected"),
    AMENDED("amended"),
    VOIDED("voided"),
    ;

    companion object {
        fun fromWire(value: String?): SyncState =
            entries.firstOrNull { it.wireValue == value } ?: DRAFT
    }
}

/**
 * وضعیت ردیف outbox — همان چهار مقدار سرور (`pending|confirmed|conflict|discarded`).
 * افزودن مقدار جدید بدون هم‌ترازی با `server/sync/**` ممنوع است.
 */
enum class OutboxStatus(val wireValue: String) {
    PENDING("pending"),
    CONFIRMED("confirmed"),
    CONFLICT("conflict"),
    DISCARDED("discarded"),
    ;

    companion object {
        fun fromWire(value: String?): OutboxStatus =
            entries.firstOrNull { it.wireValue == value } ?: PENDING
    }
}
