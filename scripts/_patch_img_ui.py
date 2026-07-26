from pathlib import Path
import re

p = Path("server/public/index.html")
text = p.read_text(encoding="utf-8")

# 1) Replace showImgPreview with album-capable version + helpers before it
old_preview = '''function showImgPreview(src){
  const ov = document.createElement('div');
  ov.className = 'img-overlay';
  ov.innerHTML = `<img src="${src}">`;
  ov.onclick = ()=>ov.remove();
  document.body.appendChild(ov);
}'''

new_preview = r'''function productImageList(p){
  if(!p) return [];
  const out=[];
  const seen=new Set();
  const push=(fn)=>{
    const name=typeof fn==='string'?fn:(fn&&fn.filename)||'';
    if(!name||seen.has(name)) return;
    seen.add(name); out.push(name);
  };
  if(Array.isArray(p.images)) p.images.forEach(push);
  else if(p.images_json){
    try{ JSON.parse(p.images_json).forEach(push); }catch(_){}
  }
  if(p.image) push(p.image);
  return out;
}
function showImgPreview(src, album){
  const urls = Array.isArray(album) && album.length
    ? album.map(u => u.startsWith('/') || u.startsWith('http') ? u : prodImgUrl(u)).filter(Boolean)
    : [src].filter(Boolean);
  if(!urls.length) return;
  let idx = Math.max(0, urls.findIndex(u => u === src));
  if(idx < 0) idx = 0;
  const ov = document.createElement('div');
  ov.className = 'img-overlay img-album';
  ov.innerHTML = `
    <button type="button" class="img-album-nav img-album-prev" aria-label="قبلی">‹</button>
    <div class="img-album-stage"><img src="${urls[idx]}" alt=""></div>
    <button type="button" class="img-album-nav img-album-next" aria-label="بعدی">›</button>
    <div class="img-album-meta"><span class="img-album-count">${idx+1} / ${urls.length}</span>
      <button type="button" class="img-album-close">بستن</button></div>`;
  const img = ov.querySelector('img');
  const count = ov.querySelector('.img-album-count');
  const paint = ()=>{ img.src = urls[idx]; count.textContent = `${idx+1} / ${urls.length}`; };
  const prev = ()=>{ idx = (idx - 1 + urls.length) % urls.length; paint(); };
  const next = ()=>{ idx = (idx + 1) % urls.length; paint(); };
  ov.querySelector('.img-album-prev').onclick = (e)=>{ e.stopPropagation(); prev(); };
  ov.querySelector('.img-album-next').onclick = (e)=>{ e.stopPropagation(); next(); };
  ov.querySelector('.img-album-close').onclick = (e)=>{ e.stopPropagation(); ov.remove(); };
  ov.querySelector('.img-album-stage').onclick = (e)=> e.stopPropagation();
  ov.onclick = ()=> ov.remove();
  document.addEventListener('keydown', function onKey(e){
    if(!document.body.contains(ov)){ document.removeEventListener('keydown', onKey); return; }
    if(e.key==='Escape') ov.remove();
    if(e.key==='ArrowRight') prev();
    if(e.key==='ArrowLeft') next();
  });
  if(urls.length < 2){
    ov.querySelector('.img-album-prev').style.display='none';
    ov.querySelector('.img-album-next').style.display='none';
  }
  document.body.appendChild(ov);
}
function openProductAlbum(p, startName){
  const list = productImageList(p);
  if(!list.length){ showToast('تصویری برای این کالا نیست','error'); return; }
  const startUrl = prodImgUrl(startName || list[0]);
  showImgPreview(startUrl, list);
}'''

if old_preview not in text:
    raise SystemExit("showImgPreview missing")
text = text.replace(old_preview, new_preview, 1)
print("album preview OK")

# 2) CSS for album
old_css = '''.img-overlay{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;
  justify-content:center;z-index:1000;cursor:zoom-out}
.img-overlay img{max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.5)}'''

new_css = '''.img-overlay{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;
  justify-content:center;z-index:1000;cursor:zoom-out;flex-direction:column;gap:12px}
.img-overlay img{max-width:90vw;max-height:80vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.5);object-fit:contain}
.img-album{flex-direction:row;gap:8px;padding:16px}
.img-album-stage{display:flex;align-items:center;justify-content:center;max-width:min(92vw,960px)}
.img-album-nav{background:rgba(255,255,255,.16);color:#fff;border:none;width:44px;height:44px;border-radius:50%;
  font-size:28px;cursor:pointer;line-height:1;flex-shrink:0}
.img-album-nav:hover{background:rgba(255,255,255,.28)}
.img-album-meta{position:absolute;bottom:18px;left:50%;transform:translateX(-50%);display:flex;gap:12px;align-items:center;
  background:rgba(0,0,0,.45);color:#fff;padding:8px 14px;border-radius:999px;font-size:13px}
.img-album-close{background:transparent;border:1px solid rgba(255,255,255,.35);color:#fff;border-radius:8px;padding:4px 10px;cursor:pointer}
.prod-thumb{width:90px;height:90px;object-fit:cover;border-radius:8px;display:block;background:#eee}
.pcard .img{position:relative}
.pcard .img-badge{position:absolute;bottom:8px;left:8px;background:rgba(0,0,0,.65);color:#fff;font-size:11px;
  padding:2px 7px;border-radius:999px;z-index:2}'''

if old_css not in text:
    raise SystemExit("img-overlay css missing")
text = text.replace(old_css, new_css, 1)
print("album css OK")

# 3) productCardHtml — album click + badge
old_card_img = '''  const imgClick = p.image
    ? `onclick="showImgPreview(prodImgUrl('${String(p.image).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'")}'))" style="cursor:zoom-in"`
    : '';
  return `<div class="pcard" style="${sel?'outline:2px solid var(--purple);background:var(--purple-light)':''}">
      ${opts.selectable?`<div style="position:absolute;top:8px;right:8px;z-index:2">
        <input type="checkbox" ${sel?'checked':''} onchange="toggleProd(${p.id},this.checked)" style="width:16px;height:16px;cursor:pointer">
      </div>`:''}
      <div class="img" ${imgClick}>${p.image?prodImgTag(p.image):'🧥'}</div>'''

# The escaping in file is single backslash for regex in JS source. Read exact:
idx = text.find("function productCardHtml")
chunk = text[idx:idx+900]
# Find the imgClick block literally from file
m = re.search(r"  const imgClick = p\.image\n    \? `onclick=.*? : '';\n  return `<div class=\"pcard\".*?<div class=\"img\" \$\{imgClick\}>\$\{p\.image\?prodImgTag\(p\.image\):'🧥'\}</div>", chunk, re.S)
if not m:
    # try simpler replace pieces
    if "const imgClick = p.image" not in chunk:
        raise SystemExit("imgClick missing in card")
    print("using stepwise card replace")
    text = text.replace(
        "  const pack = Math.max(1, parseInt(p.pack_size,10)||1);\n  const sel = !!opts.selected;\n  const imgClick = p.image\n",
        "  const pack = Math.max(1, parseInt(p.pack_size,10)||1);\n  const sel = !!opts.selected;\n  const gallery = productImageList(p);\n  const cover = gallery[0] || p.image || '';\n  const imgClick = cover\n",
        1,
    )
    # replace showImgPreview(prodImgUrl(...)) with openProductAlbum via product id cache
    # Change onclick to use openProductAlbumFromId
    old_onclick_pat = "showImgPreview(prodImgUrl('"
    # In productCardHtml specifically - replace the imgClick template
    text = text.replace(
        """  const imgClick = cover
    ? `onclick="showImgPreview(prodImgUrl('${String(p.image).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'")}'))" style="cursor:zoom-in"`
    : '';""",
        """  const imgClick = cover
    ? `onclick='openProductAlbumFromCard(${p.id})' style="cursor:zoom-in"`
    : '';""",
        1,
    )
    # If that didn't work due to escaping, try the original p.image version still present
    text = text.replace(
        """  const imgClick = cover
    ? `onclick="showImgPreview(prodImgUrl('${String(p.image).replace(/\\/g,'\\\\').replace(/'/g,"\\'")}'))" style="cursor:zoom-in"`
    : '';""",
        """  const imgClick = cover
    ? `onclick='openProductAlbumFromCard(${p.id})' style="cursor:zoom-in"`
    : '';""",
        1,
    )
    text = text.replace(
        '<div class="img" ${imgClick}>${p.image?prodImgTag(p.image):\'🧥\'}</div>',
        '<div class="img" ${imgClick}>${cover?prodImgTag(cover):\'🧥\'}${gallery.length>1?`<span class="img-badge">🖼 ${gallery.length}</span>`:\'\'}</div>',
        1,
    )
else:
    print("regex matched unexpected - skip")

# Add helper openProductAlbumFromCard near productImageList area - already in new_preview? add after
if "function openProductAlbumFromCard" not in text:
    text = text.replace(
        "function openProductAlbum(p, startName){",
        """function openProductAlbumFromCard(productId){
  const p = (CACHE.products||[]).find(x=>x.id===productId)
    || (CACHE.allProducts||[]).find(x=>x.id===productId)
    || (window._mkProds||[]).find(x=>x.id===productId);
  if(!p){ showToast('کالا یافت نشد','error'); return; }
  openProductAlbum(p);
}
function openProductAlbum(p, startName){""",
        1,
    )
    print("openProductAlbumFromCard added")

# Verify card replacements
chunk2 = text[text.find("function productCardHtml"):text.find("function canCreateInvoice")]
print("cover in card", "const cover" in chunk2)
print("albumFromCard in card", "openProductAlbumFromCard" in chunk2)
print("img-badge in card", "img-badge" in chunk2)

# 4) Fix prodModal preview thumbs
old_thumbs = '''      <div class="fg full" style="display:flex;flex-wrap:wrap;gap:8px">
        ${p.image?prodImgTag(p.image,'style="height:90px;border-radius:8px"'):''}
        ${(p.images||[]).filter(im=>(im.filename||im)!==p.image).map(im=>{
          const fn=im.filename||im; const iid=im.id||0;
          return `<div style="position:relative">${prodImgTag(fn,'style="height:90px;border-radius:8px"')}${iid&&id?`<button type="button" class="btn sm red" style="position:absolute;top:2px;left:2px" onclick="deleteProductImage(${iid},${id})">×</button>`:''}</div>`;
        }).join('')}
      </div>'''

new_thumbs = '''      <div class="fg full">
        <div class="muted" style="font-size:12px;margin-bottom:6px">پیش‌نمایش تصاویر — کلیک برای آلبوم</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px" id="p-img-preview">
        ${(()=>{
          const gallery=productImageList(p);
          if(!gallery.length) return '<span class="muted">تصویری ثبت نشده</span>';
          return gallery.map((fn,i)=>{
            const row=(p.images||[]).find(im=>(im.filename||im)===fn);
            const iid=row&&row.id?row.id:0;
            return `<div style="position:relative">
              <img class="prod-thumb" src="${prodImgUrl(fn)}" alt="" loading="lazy"
                onclick='openProductAlbum(${JSON.stringify({image:p.image,images:p.images,images_json:p.images_json}).replace(/'/g,"&#39;")}, ${JSON.stringify(fn)})'
                onerror="this.style.opacity=.3;this.alt='خطا در نمایش'">
              ${iid&&id?`<button type="button" class="btn sm red" style="position:absolute;top:2px;left:2px" onclick="event.stopPropagation();deleteProductImage(${iid},${id})">×</button>`:''}
              ${i===0?'<span class="img-badge" style="bottom:4px;left:4px">اصلی</span>':''}
            </div>`;
          }).join('');
        })()}
        </div>
      </div>'''

# The inline JSON.stringify in template is risky inside openModal backtick.
# Simpler approach: use product id + CACHE
new_thumbs = '''      <div class="fg full">
        <div class="muted" style="font-size:12px;margin-bottom:6px">پیش‌نمایش تصاویر — کلیک برای آلبوم کامل</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px" id="p-img-preview">
        ${(()=>{
          const gallery=productImageList(p);
          if(!gallery.length) return '<span class="muted">تصویری ثبت نشده</span>';
          return gallery.map((fn,i)=>{
            const row=(p.images||[]).find(im=>(im.filename||im)===fn);
            const iid=row&&row.id?row.id:0;
            const safe=String(fn).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'");
            return `<div style="position:relative;cursor:zoom-in" onclick="openProductAlbumFromCard(${id||0})">
              ${prodImgTag(fn,'class=\\"prod-thumb\\"')}
              ${iid&&id?`<button type="button" class="btn sm red" style="position:absolute;top:2px;left:2px;z-index:2" onclick="event.stopPropagation();deleteProductImage(${iid},${id})">×</button>`:''}
              ${i===0?'<span class="img-badge" style="bottom:4px;left:4px">اصلی</span>':''}
            </div>`;
          }).join('');
        })()}
        </div>
      </div>'''

if old_thumbs not in text:
    raise SystemExit("prodModal thumbs missing")
text = text.replace(old_thumbs, new_thumbs, 1)
print("prodModal thumbs OK")

# For new products id=0, openProductAlbumFromCard won't find - fix helper to accept fallback from window._prodModalImages
# Store on modal open:
# Actually when id is set, CACHE/API has images. For id=0 empty. Fine.
# When id exists but CACHE stale, prodModal already fetches /products/:id into p — but openProductAlbumFromCard uses CACHE.
# Fix: stash on window when opening modal
text = text.replace(
    "  if(!p) p={};\n  const cats=CACHE.productCategories||[];\n  openModal(`",
    "  if(!p) p={};\n  window._prodModalProduct = p;\n  const cats=CACHE.productCategories||[];\n  openModal(`",
    1,
)
text = text.replace(
    """function openProductAlbumFromCard(productId){
  const p = (CACHE.products||[]).find(x=>x.id===productId)
    || (CACHE.allProducts||[]).find(x=>x.id===productId)
    || (window._mkProds||[]).find(x=>x.id===productId);
  if(!p){ showToast('کالا یافت نشد','error'); return; }
  openProductAlbum(p);
}""",
    """function openProductAlbumFromCard(productId){
  let p = (CACHE.products||[]).find(x=>Number(x.id)===Number(productId))
    || (CACHE.allProducts||[]).find(x=>Number(x.id)===Number(productId))
    || (window._mkProds||[]).find(x=>Number(x.id)===Number(productId));
  if(!p && window._prodModalProduct && Number(window._prodModalProduct.id)===Number(productId))
    p = window._prodModalProduct;
  if(!p && window._prodModalProduct && !productId) p = window._prodModalProduct;
  if(!p){ showToast('کالا یافت نشد','error'); return; }
  openProductAlbum(p);
}""",
    1,
)
print("modal product stash OK")

# 5) renderCart — hide warehouse column for reps
old_rc = '''function renderCart(){
  const showLineDisc=canAccounting();
  const countEl=el('invCartCount'); if(countEl) countEl.textContent=fmt(invCart.length)+' ردیف';
  const colSpan=showLineDisc?8:6;
  if(!invCart.length){
    el('cartRows').innerHTML=`<div class="inv-lines-empty">سبد خالی است — از فهرست کالا یک قلم اضافه کنید</div>`;
  } else {
    el('cartRows').innerHTML = `<table class="inv-lines-tbl"><thead><tr>
      <th>کالا / خدمت</th>
      <th class="col-qty">تعداد</th>
      <th class="col-price">فی (ریال)</th>
      ${showLineDisc?`<th class="col-disc">تخفیف ٪</th><th class="col-disc-amt">تخفیف مبلغ</th>`:''}
      <th class="col-wh">انبار</th>
      <th class="col-sum">جمع ردیف</th>
      <th class="col-rm"></th>
    </tr></thead><tbody>${invCart.map((r,i)=>{
      const isIncome = r.row_type==='income';
      const gross=r.qty*r.price;
      const lineDiscAmt=showLineDisc?lineDiscApplied(r):0;
      const lineSum=Math.max(0,gross-lineDiscAmt);
      return `
      <tr>
        <td class="cn">${isIncome?'💰 ':''}${esc(r.name)}</td>
        <td class="col-qty"><input type="number" min="0.001" step="0.001" inputmode="decimal" value="${r.qty}" onchange="invCart[${i}].qty=Math.max(0.001,parseFloat(this.value)||1);if(canAccounting())invSyncLineDisc(invCart,${i},'pct');renderCart();renderInvPicker()"></td>
        <td class="col-price"><input type="number" value="${r.price}" onchange="invCart[${i}].price=+this.value||0;if(canAccounting())invSyncLineDisc(invCart,${i},'pct');renderCart()"></td>
        ${showLineDisc?`<td class="col-disc"><input type="number" min="0" max="100" step="0.01" value="${r.disc||0}" onchange="invCart[${i}].disc=+this.value||0;invSyncLineDisc(invCart,${i},'pct');renderCart()"></td>
        <td class="col-disc-amt"><input type="number" min="0" value="${r.disc_amount||0}" onchange="invCart[${i}].disc_amount=+this.value||0;invSyncLineDisc(invCart,${i},'amt');renderCart()"></td>`:''}
        <td class="col-wh">${!isIncome?`<select onchange="invCart[${i}].warehouse_id=+this.value||null"><option value="">پیش‌فرض</option>${(CACHE.warehouses||[]).filter(w=>w.active!==0).map(w=>`<option value="${w.id}" ${String(r.warehouse_id||'')===String(w.id)?'selected':''}>${esc(w.name)}</option>`).join('')}</select>`:'—'}</td>'''

new_rc = '''function renderCart(){
  const showLineDisc=canAccounting();
  const hideWhCol=typeof isRepRole==='function' && isRepRole(ME?.role);
  const defWh=ME?.sales_warehouse_id||null;
  if(hideWhCol && defWh){
    invCart.forEach(r=>{ if(r.row_type!=='income') r.warehouse_id=defWh; });
  }
  const countEl=el('invCartCount'); if(countEl) countEl.textContent=fmt(invCart.length)+' ردیف';
  const colSpan=showLineDisc?(hideWhCol?7:8):(hideWhCol?5:6);
  if(!invCart.length){
    el('cartRows').innerHTML=`<div class="inv-lines-empty">سبد خالی است — از فهرست کالا یک قلم اضافه کنید</div>`;
  } else {
    el('cartRows').innerHTML = `<table class="inv-lines-tbl"><thead><tr>
      <th>کالا / خدمت</th>
      <th class="col-qty">تعداد</th>
      <th class="col-price">فی (ریال)</th>
      ${showLineDisc?`<th class="col-disc">تخفیف ٪</th><th class="col-disc-amt">تخفیف مبلغ</th>`:''}
      ${hideWhCol?'':`<th class="col-wh">انبار</th>`}
      <th class="col-sum">جمع ردیف</th>
      <th class="col-rm"></th>
    </tr></thead><tbody>${invCart.map((r,i)=>{
      const isIncome = r.row_type==='income';
      const gross=r.qty*r.price;
      const lineDiscAmt=showLineDisc?lineDiscApplied(r):0;
      const lineSum=Math.max(0,gross-lineDiscAmt);
      return `
      <tr>
        <td class="cn">${isIncome?'💰 ':''}${esc(r.name)}</td>
        <td class="col-qty"><input type="number" min="0.001" step="0.001" inputmode="decimal" value="${r.qty}" onchange="invCart[${i}].qty=Math.max(0.001,parseFloat(this.value)||1);if(canAccounting())invSyncLineDisc(invCart,${i},'pct');renderCart();renderInvPicker()"></td>
        <td class="col-price"><input type="number" value="${r.price}" onchange="invCart[${i}].price=+this.value||0;if(canAccounting())invSyncLineDisc(invCart,${i},'pct');renderCart()"></td>
        ${showLineDisc?`<td class="col-disc"><input type="number" min="0" max="100" step="0.01" value="${r.disc||0}" onchange="invCart[${i}].disc=+this.value||0;invSyncLineDisc(invCart,${i},'pct');renderCart()"></td>
        <td class="col-disc-amt"><input type="number" min="0" value="${r.disc_amount||0}" onchange="invCart[${i}].disc_amount=+this.value||0;invSyncLineDisc(invCart,${i},'amt');renderCart()"></td>`:''}
        ${hideWhCol?'':`<td class="col-wh">${!isIncome?`<select onchange="invCart[${i}].warehouse_id=+this.value||null"><option value="">پیش‌فرض</option>${(CACHE.warehouses||[]).filter(w=>w.active!==0).map(w=>`<option value="${w.id}" ${String(r.warehouse_id||'')===String(w.id)?'selected':''}>${esc(w.name)}</option>`).join('')}</select>`:'—'}</td>`}'''

if old_rc not in text:
    raise SystemExit("renderCart head missing")
text = text.replace(old_rc, new_rc, 1)
print("renderCart warehouse hide OK")

# Force warehouse on save for reps (rows)
old_save_rows = '''    rows: invCart.map(r=>({
      product_id:r.product_id, qty:r.qty, price:r.price, disc:r.disc||0,
      disc_amount:r.disc_amount||0, description:r.description||'',
      warehouse_id:r.warehouse_id||null, row_type:r.row_type||'product',
      income_coa:r.income_coa||'', name:r.name||''
    }))'''
new_save_rows = '''    rows: invCart.map(r=>({
      product_id:r.product_id, qty:r.qty, price:r.price, disc:r.disc||0,
      disc_amount:r.disc_amount||0, description:r.description||'',
      warehouse_id:(typeof isRepRole==='function'&&isRepRole(ME?.role))?(ME?.sales_warehouse_id||null):(r.warehouse_id||null),
      row_type:r.row_type||'product',
      income_coa:r.income_coa||'', name:r.name||''
    }))'''
if old_save_rows not in text:
    raise SystemExit("save rows missing")
text = text.replace(old_save_rows, new_save_rows, 1)
print("saveInvoice warehouse force OK")

# Bump assets
text = text.replace("marketer-ui.js?v=69", "marketer-ui.js?v=70")
text = text.replace("prod-ui.css?v=69", "prod-ui.css?v=70")
text = text.replace("erp-taranom-v69", "erp-taranom-v70")
for s in ["acc-nav.js", "portal-ui.js", "mdi.js", "tbl-enhance.js", "prod-ui.js"]:
    text = text.replace(f"{s}?v=69", f"{s}?v=70")

p.write_text(text, encoding="utf-8")
print("index.html done")
