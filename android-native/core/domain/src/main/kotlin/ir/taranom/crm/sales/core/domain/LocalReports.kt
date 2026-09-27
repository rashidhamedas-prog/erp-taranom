package ir.taranom.crm.sales.core.domain

/**
 * تجمیع‌های محلی گزارش شخصی از ردیف‌های Room (بدون شبکه).
 */
object LocalReports {
    data class Snapshot(
        val customerCount: Int,
        val openFollowups: Int,
        val visitCount: Int,
        val callCount: Int,
        val draftCount: Int,
        val invoiceCount: Int,
        val receiptTotalRial: Long,
        val pendingOutbox: Int,
        val conflictOutbox: Int,
    )

    fun snapshot(
        customerCount: Int,
        openFollowups: Int,
        visitCount: Int,
        callCount: Int,
        draftCount: Int,
        invoiceCount: Int,
        receiptTotalRial: Long,
        pendingOutbox: Int,
        conflictOutbox: Int,
    ): Snapshot = Snapshot(
        customerCount = customerCount,
        openFollowups = openFollowups,
        visitCount = visitCount,
        callCount = callCount,
        draftCount = draftCount,
        invoiceCount = invoiceCount,
        receiptTotalRial = receiptTotalRial,
        pendingOutbox = pendingOutbox,
        conflictOutbox = conflictOutbox,
    )
}
