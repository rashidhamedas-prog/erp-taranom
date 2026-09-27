package ir.taranom.crm.sales.core.model

/**
 * تخصیص شناسهٔ provisional محلی — پایه از [ProvisionalIds.tableBase].
 */
object LocalIdAllocator {
    const val TABLE_CUSTOMERS = 0
    const val TABLE_SALES_DRAFTS = 1
    const val TABLE_SALES_DRAFT_LINES = 2
    const val TABLE_FOLLOWUPS = 3
    const val TABLE_VISIT_LOGS = 4
    const val TABLE_CALL_LOGS = 5
    const val TABLE_PRODUCTS = 6
    const val TABLE_PRODUCT_VARIANTS = 7
    const val TABLE_INVOICES = 8
    const val TABLE_RECEIPTS = 9
    const val TABLE_SALES_RETURNS = 10

    fun next(deviceId: Long, tableIndex: Int, currentMax: Long?): Long {
        val base = ProvisionalIds.tableBase(deviceId, tableIndex)
        return if (currentMax == null || currentMax < base) base else currentMax + 1
    }
}
