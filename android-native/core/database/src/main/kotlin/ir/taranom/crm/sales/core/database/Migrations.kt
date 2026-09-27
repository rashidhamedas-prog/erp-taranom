package ir.taranom.crm.sales.core.database

import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * سیاست migration.
 *
 * ۱. نسخه ۱ مبنا است (مشتری / پیش‌نویس سربرگ / outbox).
 * ۲. هر تغییر اسکیما ⇒ `VERSION + 1` و یک [Migration] صریح در [ALL].
 * ۳. **`fallbackToDestructiveMigration` هرگز.** پاک‌شدن دیتابیس یعنی از دست
 *    رفتن صف `pending` — یعنی سندی که فروشنده ثبت کرده و مرکز هنوز ندیده.
 *    (ADR-AND-001 §۶.۴ / §۸.۲ و §۱۰: «حفظ draft/DB/outbox» در ارتقا.)
 * ۴. اسکیمای صادرشده در `core/database/schemas/` کامیت می‌شود تا هر migration
 *    قابل بازبینی مستقل باشد.
 */
internal object Migrations {
    val MIGRATION_1_2 = object : Migration(1, 2) {
        override fun migrate(db: SupportSQLiteDatabase) {
            // Wire fields required by central push payload (entity + multipart hashes).
            db.execSQL("ALTER TABLE outbox_ops ADD COLUMN entity_table TEXT")
            db.execSQL("ALTER TABLE outbox_ops ADD COLUMN entity_local_id INTEGER")
            db.execSQL("ALTER TABLE outbox_ops ADD COLUMN file_hash TEXT")
            db.execSQL("ALTER TABLE outbox_ops ADD COLUMN file_field TEXT")

            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS sales_draft_lines (
                  local_id INTEGER NOT NULL PRIMARY KEY,
                  draft_local_id INTEGER NOT NULL,
                  product_local_id INTEGER NOT NULL,
                  product_name TEXT NOT NULL,
                  qty REAL NOT NULL,
                  unit_price INTEGER NOT NULL,
                  line_sum INTEGER NOT NULL,
                  variant_color TEXT,
                  variant_size TEXT,
                  variant_local_id INTEGER
                )
                """.trimIndent(),
            )
            db.execSQL("CREATE INDEX IF NOT EXISTS index_sales_draft_lines_draft_local_id ON sales_draft_lines(draft_local_id)")

            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS followups (
                  local_id INTEGER NOT NULL PRIMARY KEY,
                  central_id INTEGER,
                  customer_local_id INTEGER NOT NULL,
                  user_id INTEGER NOT NULL,
                  date TEXT NOT NULL,
                  time TEXT,
                  type TEXT,
                  subject TEXT NOT NULL,
                  note TEXT,
                  action TEXT,
                  next_date TEXT,
                  status TEXT NOT NULL,
                  priority TEXT NOT NULL,
                  sync_state TEXT NOT NULL,
                  created_at INTEGER NOT NULL
                )
                """.trimIndent(),
            )
            db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_followups_central_id ON followups(central_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_followups_customer_local_id ON followups(customer_local_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_followups_date ON followups(date)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_followups_status ON followups(status)")

            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS visit_logs (
                  local_id INTEGER NOT NULL PRIMARY KEY,
                  central_id INTEGER,
                  rep_id INTEGER NOT NULL,
                  customer_local_id INTEGER NOT NULL,
                  date TEXT NOT NULL,
                  note TEXT,
                  lat REAL,
                  lng REAL,
                  check_in_at INTEGER,
                  check_out_at INTEGER,
                  sync_state TEXT NOT NULL,
                  created_at INTEGER NOT NULL
                )
                """.trimIndent(),
            )
            db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_visit_logs_central_id ON visit_logs(central_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_visit_logs_customer_local_id ON visit_logs(customer_local_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_visit_logs_rep_id ON visit_logs(rep_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_visit_logs_date ON visit_logs(date)")

            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS call_logs (
                  local_id INTEGER NOT NULL PRIMARY KEY,
                  central_id INTEGER,
                  rep_id INTEGER NOT NULL,
                  customer_local_id INTEGER NOT NULL,
                  date TEXT NOT NULL,
                  duration_min INTEGER NOT NULL,
                  outcome TEXT,
                  note TEXT,
                  sync_state TEXT NOT NULL,
                  created_at INTEGER NOT NULL
                )
                """.trimIndent(),
            )
            db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_call_logs_central_id ON call_logs(central_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_call_logs_customer_local_id ON call_logs(customer_local_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_call_logs_rep_id ON call_logs(rep_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_call_logs_date ON call_logs(date)")

            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS products (
                  local_id INTEGER NOT NULL PRIMARY KEY,
                  central_id INTEGER,
                  code TEXT,
                  name TEXT NOT NULL,
                  category TEXT,
                  price_rial INTEGER NOT NULL,
                  stock REAL NOT NULL,
                  image_path TEXT,
                  unit TEXT NOT NULL,
                  active INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                )
                """.trimIndent(),
            )
            db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_products_central_id ON products(central_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_products_name ON products(name)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_products_code ON products(code)")

            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS product_variants (
                  local_id INTEGER NOT NULL PRIMARY KEY,
                  central_id INTEGER,
                  product_local_id INTEGER NOT NULL,
                  color_name TEXT,
                  size_name TEXT,
                  sku TEXT,
                  price_rial INTEGER NOT NULL,
                  stock REAL NOT NULL,
                  active INTEGER NOT NULL
                )
                """.trimIndent(),
            )
            db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_product_variants_central_id ON product_variants(central_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_product_variants_product_local_id ON product_variants(product_local_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_product_variants_sku ON product_variants(sku)")

            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS invoices (
                  local_id INTEGER NOT NULL PRIMARY KEY,
                  central_id INTEGER,
                  customer_local_id INTEGER NOT NULL,
                  document_number TEXT NOT NULL,
                  type TEXT NOT NULL,
                  date TEXT NOT NULL,
                  note TEXT,
                  subtotal INTEGER NOT NULL,
                  discount_amount INTEGER NOT NULL,
                  total_amount INTEGER NOT NULL,
                  sync_state TEXT NOT NULL,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                )
                """.trimIndent(),
            )
            db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_invoices_central_id ON invoices(central_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_invoices_customer_local_id ON invoices(customer_local_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_invoices_sync_state ON invoices(sync_state)")

            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS receipts (
                  local_id INTEGER NOT NULL PRIMARY KEY,
                  central_id INTEGER,
                  customer_local_id INTEGER NOT NULL,
                  invoice_local_id INTEGER,
                  amount INTEGER NOT NULL,
                  pay_type TEXT NOT NULL,
                  date TEXT NOT NULL,
                  note TEXT,
                  sync_state TEXT NOT NULL,
                  created_at INTEGER NOT NULL
                )
                """.trimIndent(),
            )
            db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_receipts_central_id ON receipts(central_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_receipts_customer_local_id ON receipts(customer_local_id)")

            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS sales_returns (
                  local_id INTEGER NOT NULL PRIMARY KEY,
                  central_id INTEGER,
                  customer_local_id INTEGER NOT NULL,
                  invoice_local_id INTEGER,
                  document_number TEXT NOT NULL,
                  date TEXT NOT NULL,
                  total_amount INTEGER NOT NULL,
                  note TEXT,
                  sync_state TEXT NOT NULL,
                  created_at INTEGER NOT NULL
                )
                """.trimIndent(),
            )
            db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_sales_returns_central_id ON sales_returns(central_id)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_sales_returns_customer_local_id ON sales_returns(customer_local_id)")

            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS sync_conflicts (
                  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                  entity_table TEXT NOT NULL,
                  entity_local_id INTEGER,
                  outbox_seq INTEGER,
                  message TEXT NOT NULL,
                  resolved INTEGER NOT NULL,
                  created_at INTEGER NOT NULL
                )
                """.trimIndent(),
            )
            db.execSQL("CREATE INDEX IF NOT EXISTS index_sync_conflicts_created_at ON sync_conflicts(created_at)")
            db.execSQL("CREATE INDEX IF NOT EXISTS index_sync_conflicts_resolved ON sync_conflicts(resolved)")
        }
    }

    val ALL: Array<Migration> = arrayOf(MIGRATION_1_2)
}
