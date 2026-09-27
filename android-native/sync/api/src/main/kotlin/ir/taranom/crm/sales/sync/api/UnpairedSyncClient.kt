package ir.taranom.crm.sales.sync.api

import ir.taranom.crm.sales.core.model.OutboxOp

/** دستگاه جفت نشده یا کلاینت واقعی هنوز وصل نیست. */
class SyncNotAvailableException(message: String) : IllegalStateException(message)

/**
 * Stub fail-closed: every call throws so UI never believes sync succeeded offline.
 */
class UnpairedSyncClient(
    private val reason: String = "دستگاه جفت نشده است.",
) : SyncClient {

    override suspend fun pair(
        centralUrl: String,
        username: String,
        password: String,
        deviceName: String,
    ): PairResult = fail()

    override suspend fun push(ops: List<OutboxOp>): PushResult = fail()

    override suspend fun pull(sinceSyncSeq: Long, limit: Int): PullResult = fail()

    override suspend fun fetchRow(table: String, primaryKey: String): PulledRow? = fail()

    override suspend fun downloadFile(subdir: String, fileName: String): ByteArray = fail()

    override suspend fun replayMultipart(
        op: OutboxOp,
        fileBytes: ByteArray,
        fileName: String,
    ): OpOutcome = fail()

    private fun fail(): Nothing = throw SyncNotAvailableException(reason)
}
