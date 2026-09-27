package ir.taranom.crm.sales.sync.impl.engine

import ir.taranom.crm.sales.core.model.OutboxOp
import ir.taranom.crm.sales.core.model.OutboxStatus
import ir.taranom.crm.sales.core.model.ProvisionalIds
import ir.taranom.crm.sales.sync.api.OpOutcome
import ir.taranom.crm.sales.sync.api.PairResult
import ir.taranom.crm.sales.sync.api.PullResult
import ir.taranom.crm.sales.sync.api.PulledRow
import ir.taranom.crm.sales.sync.api.PushResult
import ir.taranom.crm.sales.sync.api.SyncClient
import ir.taranom.crm.sales.sync.impl.credentials.AesGcmBox
import ir.taranom.crm.sales.sync.impl.credentials.DeviceCredentialStore
import ir.taranom.crm.sales.sync.impl.credentials.InMemoryKeyValueStore
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SyncEngineTest {

    private class FakeClient(
        private val pushOutcomes: List<OpOutcome>,
        private val pullPages: List<PullResult>,
    ) : SyncClient {
        var pushCalls = 0
        private var pullIdx = 0

        override suspend fun pair(centralUrl: String, username: String, password: String, deviceName: String) =
            PairResult(1, "tok", centralUrl)

        override suspend fun push(ops: List<OutboxOp>): PushResult {
            pushCalls++
            return PushResult(pushOutcomes, pushOutcomes.lastOrNull()?.seq)
        }

        override suspend fun pull(sinceSyncSeq: Long, limit: Int): PullResult {
            val page = pullPages.getOrElse(pullIdx) {
                PullResult(emptyList(), sinceSyncSeq, false)
            }
            pullIdx++
            return page
        }

        override suspend fun fetchRow(table: String, primaryKey: String) = null
        override suspend fun downloadFile(subdir: String, fileName: String) = ByteArray(0)
        override suspend fun replayMultipart(op: OutboxOp, fileBytes: ByteArray, fileName: String) =
            OpOutcome.Accepted(op.seq)
    }

    @Test
    fun `conflict flags outbox and never deletes — pull skips conflicted provisional`() = runBlocking {
        val master = AesGcmBox.randomMasterKey()
        val creds = DeviceCredentialStore(InMemoryKeyValueStore(), masterKeyProvider = { master })
        creds.prepareSigningKeys()
        creds.savePairing("https://127.0.0.1:9", deviceId = 1, deviceToken = "ab".repeat(32))

        val localId = ProvisionalIds.tableBase(1, 16)
        val outbox = InMemoryOutboxPort()
        outbox.enqueue(
            OutboxOp(
                seq = 1,
                method = "POST",
                path = "/api/invoices",
                bodyJson = """{"id":$localId}""",
                userId = 1,
                entityTable = "invoices",
                entityLocalId = localId,
                replayProof = "x".repeat(86),
            ),
        )
        val applier = RecordingPullApplier()
        val client = FakeClient(
            pushOutcomes = listOf(OpOutcome.Conflict(1, "موجودی کافی نیست")),
            pullPages = listOf(
                PullResult(
                    rows = listOf(
                        PulledRow("invoices", localId.toString(), 10, """{"id":$localId}""", false),
                        PulledRow("products", "1", 11, """{"id":1}""", false),
                    ),
                    nextSyncSeq = 11,
                    hasMore = false,
                ),
            ),
        )
        val engine = SyncEngine(creds, client, outbox, applier) { true }
        val result = engine.syncNow()
        assertTrue(result.ok)
        assertEquals(1, result.conflicts)
        assertEquals(OutboxStatus.CONFLICT, outbox.statusOf(1))
        assertEquals(1, applier.skipped.size)
        assertEquals(1, applier.applied.size)
        assertEquals("products", applier.applied[0].table)
    }
}
