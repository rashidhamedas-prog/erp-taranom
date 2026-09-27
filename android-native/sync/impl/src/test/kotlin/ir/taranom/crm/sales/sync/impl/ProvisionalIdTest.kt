package ir.taranom.crm.sales.sync.impl

import ir.taranom.crm.sales.core.model.ProvisionalIds
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ProvisionalIdTest {

    @Test
    fun tableBaseMatchesServerTablesJsForLegacySlot() {
        // invoices index = 16
        val base = ProvisionalIds.tableBase(deviceId = 2, tableIndex = 16)
        assertEquals(
            ProvisionalIds.PROVISIONAL_FLOOR + 2 * ProvisionalIds.DEVICE_SPAN + 16 * ProvisionalIds.TABLE_SPAN,
            base,
        )
        assertTrue(ProvisionalIds.isProvisional(base))
        assertFalse(ProvisionalIds.isProvisional(42))
    }

    @Test
    fun overflowBandForTableIndexGe100() {
        val base = ProvisionalIds.tableBase(1, 100)
        assertEquals(
            ProvisionalIds.OVERFLOW_FLOOR + 1 * ProvisionalIds.DEVICE_SPAN + 0 * ProvisionalIds.TABLE_SPAN,
            base,
        )
    }
}
