package ir.taranom.crm.sales.core.domain

import ir.taranom.crm.sales.core.model.Rial

/**
 * بدنهٔ محدود فاکتور/وصول/برگشت برای outbox (مسیرهای سرور).
 */
object FinancialCaptureService {
    const val INVOICE_PATH = "/api/invoices"
    const val INVOICE_METHOD = "POST"
    const val SALES_RETURN_PATH = "/api/accounting/sales-returns"
    const val SALES_RETURN_METHOD = "POST"
    const val RECEIPT_PATH = "/api/accounting/account-receipts"
    const val RECEIPT_METHOD = "POST"

    fun buildLimitedInvoiceBody(
        customerId: Long,
        type: String,
        date: String,
        note: String?,
        subtotal: Rial,
        discountAmount: Rial,
        finalAmount: Rial,
        localDraftId: String,
    ): String {
        val noteJson = note?.let { "\"${escape(it)}\"" } ?: "null"
        return """{"customer_id":$customerId,"type":"$type","date":"${escape(date)}","note":$noteJson,"disc":0,"disc_amt":$discountAmount,"rows":[],"subtotal":$subtotal,"final":$finalAmount,"client_draft_id":"${escape(localDraftId)}"}"""
    }

    fun buildReceiptBody(
        customerId: Long,
        amount: Rial,
        date: String,
        payType: String,
        note: String?,
    ): String {
        val noteJson = note?.let { "\"${escape(it)}\"" } ?: "null"
        return """{"customer_id":$customerId,"amount":$amount,"date":"${escape(date)}","pay_type":"${escape(payType)}","note":$noteJson}"""
    }

    fun buildReturnBody(
        customerId: Long,
        invoiceId: Long?,
        date: String,
        amount: Rial,
        note: String?,
    ): String {
        val noteJson = note?.let { "\"${escape(it)}\"" } ?: "null"
        val inv = invoiceId?.toString() ?: "null"
        return """{"customer_id":$customerId,"invoice_id":$inv,"date":"${escape(date)}","amount":$amount,"note":$noteJson}"""
    }

    private fun escape(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"")
}
