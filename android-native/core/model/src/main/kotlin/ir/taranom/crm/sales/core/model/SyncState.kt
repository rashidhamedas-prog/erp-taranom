package ir.taranom.crm.sales.core.model

/**
 * Document/op lifecycle on device — ADR-AND-001 §6.1
 * draft → local_committed → pending_push → accepted_central | needs_attention | rejected → amended | voided
 * Central rejection never silently deletes the local document.
 */
enum class SyncState(val wireValue: String) {
    DRAFT("draft"),
    LOCAL_COMMITTED("local_committed"),
    PENDING_PUSH("pending_push"),
    ACCEPTED_CENTRAL("accepted_central"),
    NEEDS_ATTENTION("needs_attention"),
    REJECTED("rejected"),
    AMENDED("amended"),
    VOIDED("voided");

    companion object {
        fun fromWire(value: String?): SyncState =
            entries.firstOrNull { it.wireValue == value } ?: DRAFT
    }
}

/**
 * Outbox row status — server values: pending|confirmed|conflict|discarded.
 */
enum class OutboxStatus(val wireValue: String) {
    PENDING("pending"),
    CONFIRMED("confirmed"),
    CONFLICT("conflict"),
    DISCARDED("discarded");

    companion object {
        fun fromWire(value: String?): OutboxStatus =
            entries.firstOrNull { it.wireValue == value } ?: PENDING
    }
}
