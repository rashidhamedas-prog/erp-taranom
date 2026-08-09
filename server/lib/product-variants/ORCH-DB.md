# ORCH — DB registration for P0-APP1 product variants

Implementer (`cursor:app1`) must **not** edit `server/db.js`. Orchestrator should wire schema init.

## 1. Call schema init (required)

In `server/db.js`, alongside other module schema inits (near `initProductionSchema` / `initInventorySchema`), **before** the second `ensureSyncColumnsForAllTables(db)` pass:

```js
try {
  require('./lib/product-variants').initProductVariantsSchema(db);
} catch (e) {
  console.error('❌ product-variants schema init failed:', e.message);
  throw e;
}
```

This creates:

- `product_colors`, `product_sizes`
- `product_style_colors`, `product_style_sizes`
- `product_variants`
- columns on `products`: `is_style`, `has_variants`, `default_variant_id`
- one-shot migration `product_variants_default_migrate_v1` (each existing product → style + default variant)

## 2. sync_seq backfill (required)

After appending the five tables to `SYNCABLE_TABLES`, add **`sync_seq_backfill_v7`** in `initSyncSchema` (same pattern as v6):

```js
const backfillV7 = db.prepare("SELECT value FROM settings WHERE key='sync_seq_backfill_v7'").get();
if (!backfillV7 || backfillV7.value !== '1') {
  for (const t of SYNCABLE_TABLES) {
    if (!tableExists(db, t.name)) continue;
    if (!tableColumns(db, t.name).includes('sync_seq')) continue;
    try {
      db.prepare(`UPDATE ${t.name} SET sync_seq = 0 WHERE sync_seq IS NULL`).run();
    } catch (e) {
      console.warn(`⚠️ sync_seq backfill v7 skipped for ${t.name}:`, e.message);
    }
  }
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('sync_seq_backfill_v7','1')").run();
}
```

Without v7, rows created before the next full sync-column pass may keep `sync_seq=NULL` and never pull to devices.

## 3. Tables already claimed in sync registry

`server/sync/tables.js` (this task) appends at end:

- `product_colors`
- `product_sizes`
- `product_style_colors`
- `product_style_sizes`
- `product_variants`

FK_COLUMNS also appended for those tables.

## 4. Idempotency

`initProductVariantsSchema` is safe to re-run (`CREATE TABLE IF NOT EXISTS` + migrate flag).
