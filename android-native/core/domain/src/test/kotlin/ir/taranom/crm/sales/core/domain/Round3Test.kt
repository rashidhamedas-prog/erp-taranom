package ir.taranom.crm.sales.core.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * fixtureهای طلایی — مقادیر انتظاری **از اجرای واقعی `server/lib/round3.js`**
 * با Node گرفته شده‌اند، نه از محاسبهٔ ذهنی. اگر سرور عوض شد، این جدول باید با
 * اجرای مجدد همان تابع به‌روز شود (ADR-AND-001 §۱۲.۲).
 */
class Round3Test {

    @Test
    fun `round3 matches node fixtures`() {
        val fixtures = listOf(
            0.0 to 0.0,
            1.0 to 1.0,
            1.0005 to 1.001,
            1.0004 to 1.0,
            2.5 to 2.5,
            -1.5 to -1.5,
            -2.5 to -2.5,
            12.3456 to 12.346,
            (1.0 / 3.0) to 0.333,
            1e-4 to 0.0,
            100.1235 to 100.124,
        )
        for ((input, expected) in fixtures) {
            assertEquals(expected, Round3.round3(input), 0.0, "round3($input)")
        }
    }

    @Test
    fun `round3 rejects non finite and null like node`() {
        assertEquals(0.0, Round3.round3(null), 0.0)
        assertEquals(0.0, Round3.round3(Double.NaN), 0.0)
        assertEquals(0.0, Round3.round3(Double.POSITIVE_INFINITY), 0.0)
        assertEquals(0.0, Round3.round3(Double.NEGATIVE_INFINITY), 0.0)
    }

    /** Node برای این ورودی `-0` می‌دهد؛ علامت صفر هم حفظ می‌شود. */
    @Test
    fun `round3 keeps negative zero like node`() {
        val actual = Round3.round3(-0.0005)
        assertTrue(
            actual.toRawBits() == (-0.0).toRawBits(),
            "expected -0.0 (as node Math.round(-0.5)), got $actual",
        )
    }

    @Test
    fun `parseQty matches node fixtures`() {
        assertEquals(0.0, Round3.parseQty(""), 0.0)
        assertEquals(0.0, Round3.parseQty(null), 0.0)
        assertEquals(1234.568, Round3.parseQty("1,234.5678"), 0.0)
        assertEquals(2.5, Round3.parseQty("  2.5 "), 0.0)
        assertEquals(0.0, Round3.parseQty("abc"), 0.0)
        assertEquals(0.0, Round3.parseQty("0.0004"), 0.0)
        assertEquals(-3.333, Round3.parseQty("-3.3333"), 0.0)
        assertEquals(12.0, Round3.parseQty("12"), 0.0)
    }

    @Test
    fun `parseQty honours fallback like node`() {
        assertEquals(2.5, Round3.parseQty(null, fallback = 2.5), 0.0)
        assertEquals(1.235, Round3.parseQty("خالی نیست ولی عدد ندارد", fallback = 1.2345), 0.0)
    }

    /** `parseFloat` پیشوند عددی را می‌خواند — `toDouble()` اینجا استثنا می‌داد. */
    @Test
    fun `parseQty reads numeric prefix like javascript parseFloat`() {
        assertEquals(12.0, Round3.parseQty("12abc"), 0.0)
        assertEquals(3.5, Round3.parseQty("3.5 متر"), 0.0)
    }

    @Test
    fun `fmtQty matches node fixtures`() {
        assertEquals("0", Round3.fmtQty(0.0))
        assertEquals("0", Round3.fmtQty(-0.0))
        assertEquals("0", Round3.fmtQty(-0.0004))
        assertEquals("1", Round3.fmtQty(1.0))
        assertEquals("1.5", Round3.fmtQty(1.5))
        assertEquals("2.346", Round3.fmtQty(2.3456))
        assertEquals("1000.1", Round3.fmtQty(1000.1))
        assertEquals("0.333", Round3.fmtQty(1.0 / 3.0))
    }

    /**
     * محافظ رگرسیون: `kotlin.math.round` ties-to-even است و اگر کسی
     * [JsMath.round] را با آن عوض کند این تست می‌شکند.
     */
    @Test
    fun `js round breaks ties toward positive infinity`() {
        assertEquals(11.0, JsMath.round(10.5), 0.0)
        assertEquals(3.0, JsMath.round(2.5), 0.0)
        assertEquals(-1.0, JsMath.round(-1.5), 0.0)
        assertEquals(-2.0, JsMath.round(-2.5), 0.0)
        assertEquals(11L, JsMath.roundToRial(10.5))
    }
}
