package ir.taranom.crm.sales.core.domain

/**
 * بدنه‌های JSON برای صف outbox — مسیرها باید با `PATH_TABLE_MAP` / capture سرور یکی باشند.
 */
object CrmCaptureService {
    const val FOLLOWUP_PATH = "/api/followups"
    const val FOLLOWUP_METHOD = "POST"

    fun visitPath(repId: Long): String = "/api/reps/$repId/visits"
    const val VISIT_METHOD = "POST"

    fun callPath(repId: Long): String = "/api/reps/$repId/calls"
    const val CALL_METHOD = "POST"

    fun buildFollowupBody(
        customerId: Long,
        date: String,
        subject: String,
        type: String? = null,
        note: String? = null,
        time: String? = null,
        action: String? = null,
        nextDate: String? = null,
        priority: String = "mid",
        status: String = "open",
    ): String = buildString {
        append('{')
        append("\"cust_id\":$customerId,")
        append("\"date\":\"${escape(date)}\",")
        append("\"subject\":\"${escape(subject)}\",")
        append("\"type\":${nullableString(type)},")
        append("\"note\":${nullableString(note)},")
        append("\"time\":${nullableString(time)},")
        append("\"action\":${nullableString(action)},")
        append("\"next_date\":${nullableString(nextDate)},")
        append("\"priority\":\"${escape(priority)}\",")
        append("\"status\":\"${escape(status)}\"")
        append('}')
    }

    fun buildVisitBody(
        customerId: Long,
        date: String,
        note: String? = null,
        lat: Double? = null,
        lng: Double? = null,
        checkInAt: Long? = null,
        checkOutAt: Long? = null,
    ): String = buildString {
        append('{')
        append("\"customer_id\":$customerId,")
        append("\"date\":\"${escape(date)}\",")
        append("\"note\":${nullableString(note)},")
        append("\"lat\":${lat ?: "null"},")
        append("\"lng\":${lng ?: "null"},")
        append("\"check_in_at\":${checkInAt ?: "null"},")
        append("\"check_out_at\":${checkOutAt ?: "null"}")
        append('}')
    }

    fun buildCallBody(
        customerId: Long,
        date: String,
        durationMin: Int = 0,
        outcome: String? = null,
        note: String? = null,
    ): String = buildString {
        append('{')
        append("\"customer_id\":$customerId,")
        append("\"date\":\"${escape(date)}\",")
        append("\"duration_min\":$durationMin,")
        append("\"outcome\":${nullableString(outcome)},")
        append("\"note\":${nullableString(note)}")
        append('}')
    }

    private fun nullableString(value: String?): String =
        value?.let { "\"${escape(it)}\"" } ?: "null"

    private fun escape(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"")
}
