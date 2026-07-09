const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { auth, adminOnly, centralOnly } = require('../middleware/auth');
const { getDB } = require('../db');
const { extractZip, analyzeExtracted, mssqlConfig, importFromMssql, ensureImportDir } = require('../lib/mahak-import');

const uploadDir = path.join(ensureImportDir(), 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 1024 * 1024 * 1024 }
});

router.post('/mahak/upload', auth, adminOnly, centralOnly, upload.single('backup'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایل FullBackup.zip انتخاب نشده است' });
  try {
    const dir = extractZip(req.file.path);
    const analysis = analyzeExtracted(dir);
    try { fs.unlinkSync(req.file.path); } catch { /* */ }
    res.json({ ok: true, ...analysis, mssql_configured: !!mssqlConfig() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/mahak/status', auth, adminOnly, centralOnly, (req, res) => {
  res.json({
    mssql_configured: !!mssqlConfig(),
    hint: 'پس از استخراج FullBackup، فایل‌های .bak را روی SQL Server بازگردانی کنید و متغیرهای MAHAK_MSSQL_SERVER و MAHAK_MSSQL_DATABASE را تنظیم کنید.'
  });
});

router.post('/mahak/run', auth, adminOnly, centralOnly, async (req, res) => {
  try {
    const db = getDB();
    const stats = await importFromMssql(db, req.body || {});
    res.json({ ok: true, stats });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
