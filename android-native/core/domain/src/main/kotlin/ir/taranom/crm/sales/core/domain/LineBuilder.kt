package ir.taranom.crm.sales.core.domain

import ir.taranom.crm.sales.core.model.Rial
import ir.taranom.crm.sales.core.model.VatClass
import kotlin.math.max

/**
 * Parity with `server/routes/invoices.js` buildRows:
 * discount **amount** wins over discount **percent** when both are conceptually present.
 */
data class BuiltLine(
    val productId: Long,
    val qty: Double,
    val unitPrice: Rial,
    val discountAmount: Rial,
    val sum: Rial,
    val vatClass: VatClass,
)

data class BuiltRows(
    val rows: List<BuiltLine>,
    val subtotal: Rial,
)

object LineBuilder {
    data class InputLine(
        val productId: Long,
        val qty: Any?,
        val unitPrice: Rial,
        val discountAmount: Rial? = null,
        val discountPercent: Double? = null,
        val vatClass: VatClass = VatClass.TAXABLE,
    )

    fun buildRows(lines: List<InputLine>): BuiltRows {
        val built = lines.map { line ->
            val qty = when (val q = line.qty) {
                null -> Round3.round3(0.0)
                is Number -> Round3.round3(q.toDouble())
                else -> Round3.parseQty(q.toString())
            }
            val price = max(0L, line.unitPrice)
            val raw = qty * price.toDouble()
            val rawRial = JsMath.roundToRial(raw)
            val disc = when {
                line.discountAmount != null -> max(0L, line.discountAmount)
                line.discountPercent != null -> {
                    val pct = line.discountPercent.coerceIn(0.0, 100.0)
                    JsMath.roundToRial(raw * pct / 100.0)
                }
                else -> 0L
            }.coerceAtMost(rawRial)
            BuiltLine(
                productId = line.productId,
                qty = qty,
                unitPrice = price,
                discountAmount = disc,
                sum = (rawRial - disc).coerceAtLeast(0L),
                vatClass = line.vatClass,
            )
        }
        return BuiltRows(rows = built, subtotal = built.sumOf { it.sum })
    }

    fun toVatLines(built: BuiltRows): List<VatLine> =
        built.rows.map { VatLine(it.productId, it.sum, it.vatClass) }
}

/** Customer visibility — `user_id OR assigned_to` (non-admin). */
object CustomerScope {
    fun visibleTo(userId: Long, ownerUserId: Long?, assignedTo: Long?): Boolean =
        ownerUserId == userId || assignedTo == userId
}
