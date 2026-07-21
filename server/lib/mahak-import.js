/**
 * Mahak (محک) import — CANCELLED.
 * Runtime import from FullBackup.zip / MSSQL is intentionally disabled.
 * Historical one-off scripts under server/scripts/*mahak* remain for archive only
 * and are excluded from the Android APK.
 */
const CANCELLED = 'واردات محک لغو شده است و دیگر پشتیبانی نمی‌شود.';

function cancelled() {
  throw new Error(CANCELLED);
}

module.exports = {
  CANCELLED: true,
  get IMPORT_ROOT() { return null; },
  getImportRoot: cancelled,
  ensureImportDir: cancelled,
  extractZip: cancelled,
  analyzeExtracted: cancelled,
  mssqlConfig: () => null,
  discoverTables: cancelled,
  importFromMssql: cancelled,
};
