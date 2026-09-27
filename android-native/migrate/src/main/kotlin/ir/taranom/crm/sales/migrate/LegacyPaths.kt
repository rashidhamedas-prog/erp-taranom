package ir.taranom.crm.sales.migrate

/**
 * مسیرهای شناخته‌شدهٔ SQLite نسخهٔ legacy (nodejs-mobile + WebView).
 *
 * شواهد: `MainActivity` → `filesDir/crm-data`؛ برخی بیلدها `filesDir/data`.
 * Migrator هر دو را به ترتیب اولویت امتحان می‌کند؛ بازنویسی محصول legacy ممنوع.
 */
object LegacyPaths {
    const val DATA_DIR_PRIMARY = "crm-data"
    const val DATA_DIR_FALLBACK = "data"
    const val DB_FILE_NAME = "crm.db"
    const val JWT_SECRET_FILE = "jwt-secret"
    const val UPLOADS_DIR = "uploads"

    /** نام‌های کاندید نسبی به `Context.filesDir`. */
    val CANDIDATE_DB_RELATIVE: List<String> = listOf(
        "$DATA_DIR_PRIMARY/$DB_FILE_NAME",
        "$DATA_DIR_FALLBACK/$DB_FILE_NAME",
    )
}
