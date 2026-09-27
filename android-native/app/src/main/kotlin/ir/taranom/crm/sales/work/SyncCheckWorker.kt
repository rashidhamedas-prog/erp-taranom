package ir.taranom.crm.sales.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * stub همگام‌سازی دوره‌ای — تا سیم‌کشی `sync:impl` فقط no-op امن.
 * صف outbox روی دیسک می‌ماند؛ شکست شبکه داده را پاک نمی‌کند (ADR §۸.۳).
 */
class SyncCheckWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        // فاز ۴: فقط ثبت نوبت WorkManager. push/pull واقعی پس از sync:impl.
        return Result.success()
    }

    companion object {
        const val UNIQUE_NAME = "taranom_sync_check"
    }
}
