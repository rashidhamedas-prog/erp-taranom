package ir.taranom.crm.sales.migrate

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.io.File

/**
 * باز کردن فقط‌خواندنی `crm.db` نسخهٔ nodejs-mobile در صورت وجود روی دستگاه.
 */
class AndroidLegacySqliteSource(
    private val dbFile: File,
) : LegacySqliteSource {

    private var db: SQLiteDatabase? = null

    override fun exists(): Boolean = dbFile.isFile && dbFile.canRead()

    override fun tableExists(name: String): Boolean {
        val database = open() ?: return false
        database.rawQuery(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
            arrayOf(name),
        ).use { c -> return c.moveToFirst() }
    }

    override fun queryRows(
        table: String,
        columns: List<String>,
        where: String?,
    ): List<Map<String, String?>> {
        require(table in AllowedSalesTables.ALL_READABLE) {
            FailClosedRules.UNSUPPORTED_TABLE
        }
        val database = open() ?: return emptyList()
        val cols = columns.joinToString(",") { sanitizeIdent(it) }
        val sql = buildString {
            append("SELECT ").append(cols).append(" FROM ").append(sanitizeIdent(table))
            if (!where.isNullOrBlank()) append(" WHERE ").append(where)
        }
        val out = mutableListOf<Map<String, String?>>()
        database.rawQuery(sql, null).use { c ->
            while (c.moveToNext()) {
                val row = linkedMapOf<String, String?>()
                for (col in columns) {
                    val idx = c.getColumnIndex(col)
                    row[col] = if (idx < 0 || c.isNull(idx)) null else c.getString(idx)
                }
                out += row
            }
        }
        return out
    }

    override fun close() {
        db?.close()
        db = null
    }

    private fun open(): SQLiteDatabase? {
        if (!exists()) return null
        val existing = db
        if (existing != null && existing.isOpen) return existing
        return try {
            SQLiteDatabase.openDatabase(
                dbFile.absolutePath,
                null,
                SQLiteDatabase.OPEN_READONLY,
            ).also { db = it }
        } catch (_: Exception) {
            null
        }
    }

    private fun sanitizeIdent(name: String): String {
        require(name.matches(Regex("^[A-Za-z_][A-Za-z0-9_]*$"))) { "bad_ident" }
        return name
    }

    companion object {
        /** اولین مسیر موجود از [LegacyPaths.CANDIDATE_DB_RELATIVE]. */
        fun find(context: Context): AndroidLegacySqliteSource? {
            val files = context.applicationContext.filesDir
            for (rel in LegacyPaths.CANDIDATE_DB_RELATIVE) {
                val f = File(files, rel)
                if (f.isFile && f.canRead()) return AndroidLegacySqliteSource(f)
            }
            return null
        }
    }
}
