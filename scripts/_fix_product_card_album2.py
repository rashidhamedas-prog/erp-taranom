# -*- coding: utf-8 -*-
from pathlib import Path

p = Path("server/public/index.html")
t = p.read_text(encoding="utf-8")

# 1) Fix gallery map to use filename
old_g = """  const gallery = Array.isArray(p.images) && p.images.length
    ? p.images.map(im => im.path || im).filter(Boolean)
    : (p.image ? [p.image] : []);"""
new_g = """  const gallery = Array.isArray(p.images) && p.images.length
    ? p.images.map(im => (typeof im==='string'?im:(im.filename||im.path||''))).filter(Boolean)
    : (p.image ? [p.image] : []);"""
if old_g not in t:
    raise SystemExit("gallery block not found")
t = t.replace(old_g, new_g, 1)

# 2) Fix img div in productCardHtml — still uses undefined imgClick
old_img = '      <div class="img" ${imgClick}>${p.image?prodImgTag(p.image):\'🧥\'}</div>'
new_img = '      <div class="img" ${albumFromCard}>${imgBadge}${cover?prodImgTag(cover):\'🧥\'}</div>'
if old_img not in t:
    # try alternate emoji
    import re
    m = re.search(r'      <div class="img" \$\{imgClick\}>\$\{p\.image\?prodImgTag\(p\.image\):\'[^\']+\'\}</div>', t)
    if not m:
        raise SystemExit("img div not found: " + repr(t[t.find('function productCardHtml'):t.find('function productCardHtml')+900][-200:]))
    old_img = m.group(0)
    print("found via regex:", repr(old_img))
t = t.replace(old_img, new_img, 1)

# 3) Fix openProductAlbumFromCard to accept DOM el with data-album OR product id
old_fn = """function openProductAlbumFromCard(productId){
  let p = (CACHE.products||[]).find(x=>Number(x.id)===Number(productId))
    || (CACHE.allProducts||[]).find(x=>Number(x.id)===Number(productId))
    || (window._mkProds||[]).find(x=>Number(x.id)===Number(productId));
  if(!p && window._prodModalProduct && Number(window._prodModalProduct.id)===Number(productId))
    p = window._prodModalProduct;
  if(!p && window._prodModalProduct && !productId) p = window._prodModalProduct;
  if(!p){ showToast('کالا یافت نشد','error'); return; }
  openProductAlbum(p);
}"""
new_fn = """function openProductAlbumFromCard(arg){
  // DOM card with data-album JSON, or product id number/string
  if(arg && arg.nodeType===1){
    const raw=arg.getAttribute('data-album')||'';
    try{
      const list=JSON.parse(raw);
      if(Array.isArray(list)&&list.length){
        showImgPreview(prodImgUrl(list[0]), list);
        return;
      }
    }catch(_){}
    return;
  }
  const productId=arg;
  let p = (CACHE.products||[]).find(x=>Number(x.id)===Number(productId))
    || (CACHE.allProducts||[]).find(x=>Number(x.id)===Number(productId))
    || (window._mkProds||[]).find(x=>Number(x.id)===Number(productId));
  if(!p && window._prodModalProduct && Number(window._prodModalProduct.id)===Number(productId))
    p = window._prodModalProduct;
  if(!p && window._prodModalProduct && !productId) p = window._prodModalProduct;
  if(!p){ showToast('کالا یافت نشد','error'); return; }
  openProductAlbum(p);
}"""
if old_fn not in t:
    raise SystemExit("openProductAlbumFromCard not found")
t = t.replace(old_fn, new_fn, 1)

p.write_text(t, encoding="utf-8")

# verify
fn = t.find("function productCardHtml")
seg = t[fn:fn+2200]
print("imgClick leftover", "${imgClick}" in seg)
print("albumFromCard in img", "${albumFromCard}" in seg)
print("cover tag", "prodImgTag(cover)" in seg)
print("openProductAlbumFromCard data-album", "data-album" in t[t.find("function openProductAlbumFromCard"):t.find("function openProductAlbumFromCard")+500])
print("OK")
