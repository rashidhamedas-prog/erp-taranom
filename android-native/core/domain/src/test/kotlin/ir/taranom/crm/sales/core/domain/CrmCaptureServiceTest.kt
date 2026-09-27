package ir.taranom.crm.sales.core.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CrmCaptureServiceTest {
    @Test
    fun followupBodyContainsCustIdAndPathConstant() {
        val body = CrmCaptureService.buildFollowupBody(
            customerId = 42,
            date = "1405/07/05",
            subject = "پیگیری",
        )
        assertTrue(body.contains("\"cust_id\":42"))
        assertTrue(body.contains("\"subject\":\"پیگیری\""))
        assertEquals("/api/followups", CrmCaptureService.FOLLOWUP_PATH)
    }

    @Test
    fun visitAndCallPathsMatchServerShape() {
        assertEquals("/api/reps/7/visits", CrmCaptureService.visitPath(7))
        assertEquals("/api/reps/7/calls", CrmCaptureService.callPath(7))
        val call = CrmCaptureService.buildCallBody(3, "1405/07/05", 5, "جواب داد", null)
        assertTrue(call.contains("\"duration_min\":5"))
        assertTrue(call.contains("\"customer_id\":3"))
    }
}
