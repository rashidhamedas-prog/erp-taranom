package ir.taranom.crm.sales.sync.impl.engine

import ir.taranom.crm.sales.core.model.OutboxOp
import ir.taranom.crm.sales.core.model.OutboxStatus
import ir.taranom.crm.sales.core.model.ProvisionalIds
import ir.taranom.crm.sales.sync.api.OpOutcome
import ir.taranom.crm.sales.sync.api.PulledRow
import ir.taranom.crm.sales.sync.api.SyncClient
import ir.taranom.crm.sales.sync.api.SyncNotAvailableException
import ir.taranom.crm.sales.sync.impl.credentials.DeviceCredentialStore
import ir.taranom.crm.sales.sync.impl.http.OkHttpSyncClient
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Port over Room [OutboxDao] so SyncEngine stays JVM-testable.
 */
interface OutboxPort {
    suspend fun nextPending(limit: Int): List<OutboxOp>
    suspend fun markStatus(seq: Long, status: OutboxStatus, error: String?)
}

/**
 * Applies pull rows. Must never silently overwrite a local row that still has
 * a conflicted / pending outbox create (ADR §۸.۱).
 */
interface PullApplier {
    /**
     * @param conflictedLocalIds provisional entity ids currently in conflict/pending
     *        that must not be replaced by a central row with the same logical key
     *        until human discard — for id-keyed tables, skip apply when row id
     *        is provisional and still local-owned.
     */
    suspend fun applyRows(rows: List<PulledRow>, conflictedLocalIds: Set<Long>)
}

data class SyncCycleResult(
    val ok: Boolean,
    val pushed: Int = 0,
    val confirmed: Int = 0,
    val conflicts: Int = 0,
    val pulled: Int = 0,
    val error: String? = null,
)

/**
 * Drain outbox → push → pull incremental sync_seq.
 * Stop-at-first conflict/defer; never LWW financial overwrites.
 */
class SyncEngine(
    private val credentials: DeviceCredentialStore,
    private val client: SyncClient,
    private val outbox: OutboxPort,
    private val pullApplier: PullApplier,
    private val httpProbe: (String) -> Boolean = { url ->
        OkHttpSyncClient.probe(OkHttpSyncClient.defaultClient(), url)
    },
) {
    private val mutex = Mutex()

    @Volatile
    var syncing: Boolean = false
        private set

    suspend fun syncNow(pushBatchLimit: Int = 400, pullPageLimit: Int = 2000): SyncCycleResult =
        mutex.withLock {
            if (!credentials.isPaired) {
                return SyncCycleResult(ok = false, error = "دستگاه هنوز به سرور مرکزی متصل نشده است")
            }
            if (syncing) {
                return SyncCycleResult(ok = false, error = "همگام‌سازی در حال اجراست")
            }
            syncing = true
            try {
                val base = credentials.centralUrl
                    ?: return SyncCycleResult(ok = false, error = "central_url missing")
                if (!httpProbe(base)) {
                    return SyncCycleResult(ok = false, error = "سرور مرکزی در دسترس نیست")
                }

                val pending = outbox.nextPending(pushBatchLimit)
                var confirmed = 0
                var conflicts = 0
                val protectedLocalIds = linkedSetOf<Long>()
                if (pending.isNotEmpty()) {
                    val push = client.push(pending)
                    val outcomeBySeq = push.outcomes.associateBy { it.seq }
                    for (op in pending) {
                        when (val outcome = outcomeBySeq[op.seq]) {
                            is OpOutcome.Accepted -> {
                                outbox.markStatus(outcome.seq, OutboxStatus.CONFIRMED, null)
                                confirmed++
                            }
                            is OpOutcome.Conflict -> {
                                // Keep local document; flag for human — never delete
                                outbox.markStatus(outcome.seq, OutboxStatus.CONFLICT, outcome.reason)
                                conflicts++
                                op.entityLocalId?.takeIf { ProvisionalIds.isProvisional(it) }
                                    ?.let { protectedLocalIds += it }
                            }
                            is OpOutcome.Deferred -> {
                                // Stay pending; retry next cycle
                                outbox.markStatus(outcome.seq, OutboxStatus.PENDING, outcome.reason)
                                op.entityLocalId?.takeIf { ProvisionalIds.isProvisional(it) }
                                    ?.let { protectedLocalIds += it }
                            }
                            null -> {
                                // Stop-at-first-failure: later ops not in results stay pending
                                op.entityLocalId?.takeIf { ProvisionalIds.isProvisional(it) }
                                    ?.let { protectedLocalIds += it }
                            }
                        }
                    }
                }

                val conflictedLocals = protectedLocalIds

                var pulled = 0
                var since = credentials.lastPullSeq()
                var pages = 0
                var more = true
                while (more) {
                    pages++
                    if (pages > 5000) throw SyncNotAvailableException("دریافت تغییرات از سرور بیش از حد طول کشید")
                    val page = client.pull(since, pullPageLimit)
                    if (page.rows.isNotEmpty()) {
                        pullApplier.applyRows(page.rows, conflictedLocals)
                        pulled += page.rows.size
                    }
                    since = page.nextSyncSeq
                    credentials.setLastPullSeq(since)
                    more = page.hasMore && page.rows.isNotEmpty()
                }
                credentials.markInitialSyncDone()
                SyncCycleResult(
                    ok = true,
                    pushed = pending.size,
                    confirmed = confirmed,
                    conflicts = conflicts,
                    pulled = pulled,
                )
            } catch (e: Exception) {
                SyncCycleResult(ok = false, error = e.message ?: e::class.simpleName)
            } finally {
                syncing = false
            }
        }

    /**
     * Pair via admin provision endpoint then run first pull.
     */
    suspend fun pairAndInitialPull(
        centralUrl: String,
        username: String,
        password: String,
        deviceName: String,
    ): SyncCycleResult {
        client.pair(centralUrl, username, password, deviceName)
        return syncNow()
    }
}

/** In-memory outbox for JVM unit tests. */
class InMemoryOutboxPort : OutboxPort {
    private val ops = linkedMapOf<Long, OutboxOp>()
    private var seqGen = 1L

    fun enqueue(op: OutboxOp): Long {
        val seq = if (op.seq > 0) op.seq else seqGen++
        ops[seq] = op.copy(seq = seq, status = OutboxStatus.PENDING)
        return seq
    }

    fun statusOf(seq: Long): OutboxStatus? = ops[seq]?.status

    override suspend fun nextPending(limit: Int): List<OutboxOp> =
        ops.values.filter { it.status == OutboxStatus.PENDING }.sortedBy { it.seq }.take(limit)

    override suspend fun markStatus(seq: Long, status: OutboxStatus, error: String?) {
        val cur = ops[seq] ?: return
        // Deferred keeps pending
        val next = if (status == OutboxStatus.PENDING) OutboxStatus.PENDING else status
        ops[seq] = cur.copy(status = next, lastError = error, attemptCount = cur.attemptCount + 1)
    }
}

/** Recording applier for tests. */
class RecordingPullApplier : PullApplier {
    val applied = mutableListOf<PulledRow>()
    val skipped = mutableListOf<PulledRow>()

    override suspend fun applyRows(rows: List<PulledRow>, conflictedLocalIds: Set<Long>) {
        for (row in rows) {
            val id = row.primaryKey.toLongOrNull()
            if (id != null && ProvisionalIds.isProvisional(id) && id in conflictedLocalIds && !row.deleted) {
                // Never silent-overwrite conflicted local provisional rows
                skipped += row
            } else {
                applied += row
            }
        }
    }
}
