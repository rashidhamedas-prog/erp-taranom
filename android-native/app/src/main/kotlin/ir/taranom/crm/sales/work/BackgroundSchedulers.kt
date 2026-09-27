package ir.taranom.crm.sales.work

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit

/**
 * زمان‌بندی WorkManager برای sync و update — جدا از مسیر فروش آفلاین.
 */
object BackgroundSchedulers {

    fun enqueueDefaults(context: Context, centralBaseUrl: String? = null) {
        val wm = WorkManager.getInstance(context.applicationContext)

        val net = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val syncReq = PeriodicWorkRequestBuilder<SyncCheckWorker>(6, TimeUnit.HOURS)
            .setConstraints(net)
            .build()
        wm.enqueueUniquePeriodicWork(
            SyncCheckWorker.UNIQUE_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            syncReq,
        )

        val updateData = workDataOf(
            UpdateCheckWorker.KEY_BASE_URL to (centralBaseUrl ?: ""),
        )
        val updateReq = PeriodicWorkRequestBuilder<UpdateCheckWorker>(12, TimeUnit.HOURS)
            .setConstraints(net)
            .setInputData(updateData)
            .build()
        wm.enqueueUniquePeriodicWork(
            UpdateCheckWorker.UNIQUE_NAME,
            ExistingPeriodicWorkPolicy.UPDATE,
            updateReq,
        )
    }
}
