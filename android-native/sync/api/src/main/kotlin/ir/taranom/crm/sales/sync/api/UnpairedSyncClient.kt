package ir.taranom.crm.sales.sync.api

import ir.taranom.crm.sales.core.model.OutboxOp

/** دستگاه جفت نشده یا کلاینت واقعی هنوز وصل نیست. */
class SyncNotAvailableException(message: String) : IllegalStateException(message)

/**
 * پیاده‌سازی stub فاز ۰.
 *
 * عمداً هیچ کاری «تقریبی» انجام نمی‌دهد و سکوت هم نمی‌کند: هر تماس استثنا
 * می‌دهد تا هیچ مسیری به‌اشتباه فکر نکند sync انجام شده. اپ باید بدون این
 * کلاینت هم کامل کار کند (آزمون air-gap، ADR §۱.۵ بند ۱).
 */
class UnpairedSyncClient(
    private val reason: String = "دستگاه جفت نشده است؛ کلاینت واقعی sync در فاز ۱ اضافه می‌شود.",
) : SyncClient {

    override suspend fun pair(pairingCode: String, deviceLabel: String): PairResult = fail()

    override suspend fun push(ops: List<OutboxOp>): PushResult = fail()

    override suspend fun pull(sinceSyncSeq: Long, limit: Int): PullResult = fail()

    override suspend fun fetchRow(table: String, primaryKey: String): PulledRow? = fail()

    override suspend fun listFiles(sinceSyncSeq: Long): List<RemoteFile> = fail()

    override suspend fun replayMultipart(
        op: OutboxOp,
        fileBytes: ByteArray,
        fileName: String,
    ): OpOutcome = fail()

    private fun fail(): Nothing = throw SyncNotAvailableException(reason)
}
