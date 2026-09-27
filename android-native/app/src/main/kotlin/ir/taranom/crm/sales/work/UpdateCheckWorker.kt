package ir.taranom.crm.sales.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import ir.taranom.crm.sales.BuildConfig
import ir.taranom.crm.sales.update.ApkUpdateEvaluator
import ir.taranom.crm.sales.update.ManifestUpdateChecker

/**
 * بررسی دوره‌ای آپدیت APK در برابر `releases/manifest.json`.
 * فقط اعلام/لاگ — نصب PackageInstaller در موج بعدی پس از تأیید UI.
 */
class UpdateCheckWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val baseUrl = inputData.getString(KEY_BASE_URL)?.trim().orEmpty()
        if (baseUrl.isEmpty()) {
            // هنوز paired نیست یا URL مرکز تنظیم نشده — موفقیت بی‌عمل (stub).
            return Result.success()
        }
        return try {
            val checker = ManifestUpdateChecker()
            val result = checker.check(
                baseUrl = baseUrl,
                currentVersion = BuildConfig.VERSION_NAME,
                currentVersionCode = BuildConfig.VERSION_CODE.toLong(),
            )
            if (result.downloadable) {
                ApkUpdateEvaluator.assertDownloadable(result).getOrThrow()
                // TODO(phase-5): اعلان UI + دانلود تأییدشده (SHA/signer/package).
            }
            Result.success()
        } catch (_: Exception) {
            // خرابی feed نباید فروش آفلاین را متوقف کند (ADR §۱۰).
            Result.retry()
        }
    }

    companion object {
        const val UNIQUE_NAME = "taranom_update_check"
        const val KEY_BASE_URL = "central_base_url"
    }
}
