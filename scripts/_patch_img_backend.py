from pathlib import Path

# ---------- products.js: better optimize + larger upload limit ----------
p = Path("server/routes/products.js")
text = p.read_text(encoding="utf-8")

old_multer = "const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });"
new_multer = "const upload = multer({ storage, limits: { fileSize: 12 * 1024 * 1024 } });"
if old_multer in text:
    text = text.replace(old_multer, new_multer, 1)
    print("multer limit 12MB")

old_save = '''async function saveImage(buffer, originalName) {
  if (sharp) {
    try {
      const filename = 'p_' + Date.now() + '_' + Math.round(Math.random() * 1e6) + '.webp';
      const dest = path.join(UPLOAD_DIR, filename);
      await sharp(buffer)
        .resize(600, 600, { fit: 'cover', position: 'centre' })
        .webp({ quality: 82 })
        .toFile(dest);
      return filename;
    } catch (e) {
      console.error('sharp processing failed, saving original:', e.message);
    }
  }
  const ext = path.extname(originalName || '').toLowerCase() || '.jpg';
  const fallback = 'p_' + Date.now() + '_' + Math.round(Math.random() * 1e6) + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, fallback), buffer);
  return fallback;
}'''

new_save = '''async function saveImage(buffer, originalName) {
  // Auto-optimize for app: max edge 1280, WebP ~75, strip metadata (keeps aspect ratio).
  if (sharp) {
    try {
      const filename = 'p_' + Date.now() + '_' + Math.round(Math.random() * 1e6) + '.webp';
      const dest = path.join(UPLOAD_DIR, filename);
      await sharp(buffer)
        .rotate() // honor EXIF orientation from phone cameras
        .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 75, effort: 4 })
        .toFile(dest);
      return filename;
    } catch (e) {
      console.error('sharp processing failed, saving original:', e.message);
    }
  }
  const ext = path.extname(originalName || '').toLowerCase() || '.jpg';
  const fallback = 'p_' + Date.now() + '_' + Math.round(Math.random() * 1e6) + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, fallback), buffer);
  return fallback;
}'''

if old_save not in text:
    raise SystemExit("saveImage block missing")
text = text.replace(old_save, new_save, 1)
print("saveImage optimized")

# Enrich GET / list with images from images_json / product_images (lightweight)
old_list_end = '''  const rows = db.prepare(`
    SELECT p.*, w.name as warehouse_name${whSelect}
    FROM products p
    LEFT JOIN warehouses w ON p.warehouse_id=w.id
    LEFT JOIN product_categories pc ON pc.id=p.category_id
    ${whereSql} ORDER BY p.created_at DESC
  `).all(...params);
  res.json(rows);
});'''

new_list_end = '''  const rows = db.prepare(`
    SELECT p.*, w.name as warehouse_name${whSelect}
    FROM products p
    LEFT JOIN warehouses w ON p.warehouse_id=w.id
    LEFT JOIN product_categories pc ON pc.id=p.category_id
    ${whereSql} ORDER BY p.created_at DESC
  `).all(...params);
  // Attach gallery filenames for album UI (catalog / marketer / cards)
  for (const row of rows) {
    let imgs = listProductImages(db, row.id);
    if (!imgs.length && row.images_json) {
      try {
        imgs = JSON.parse(row.images_json).map((filename, i) => ({ id: 0, filename, sort_order: i }));
      } catch (_) { imgs = []; }
    }
    if (!imgs.length && row.image) imgs = [{ id: 0, filename: row.image, sort_order: 0 }];
    row.images = imgs;
    if (!row.image && imgs[0]) row.image = imgs[0].filename;
  }
  res.json(rows);
});'''

if old_list_end not in text:
    raise SystemExit("list end missing")
text = text.replace(old_list_end, new_list_end, 1)
print("GET / attaches images")

# Also ensure GET /:id sets image from gallery if missing
old_get_id = '''  row.images = listProductImages(db, row.id);
  if (!row.images.length && row.images_json) {
    try { row.images = JSON.parse(row.images_json).map((filename, i) => ({ id: 0, filename, sort_order: i })); } catch (_) {}
  }'''
# find exact after GET /:id
if "if (!row.image && row.images" not in text:
    text = text.replace(
        old_get_id,
        old_get_id + "\n  if (!row.image && row.images && row.images[0]) row.image = row.images[0].filename;",
        1,
    )
    print("GET /:id primary image fallback")

p.write_text(text, encoding="utf-8")
print("products.js OK")
