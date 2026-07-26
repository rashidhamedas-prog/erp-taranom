# -*- coding: utf-8 -*-
from pathlib import Path

p = Path("server/public/index.html")
t = p.read_text(encoding="utf-8")

a = t.find("  const imgClick = p.image")
b = t.find('  return `<div class="pcard"', a)
assert a > 0 and b > a, (a, b)

new_vars = """  const gallery = Array.isArray(p.images) && p.images.length
    ? p.images.map(im => im.path || im).filter(Boolean)
    : (p.image ? [p.image] : []);
  const cover = gallery[0] || p.image || '';
  const albumFromCard = gallery.length
    ? `onclick="event.stopPropagation();openProductAlbumFromCard(this)" data-album="${esc(JSON.stringify(gallery))}" style="cursor:zoom-in"`
    : '';
  const imgBadge = gallery.length > 1
    ? `<span class="img-badge">${gallery.length} عکس</span>`
    : '';
"""
t = t[:a] + new_vars + t[b:]

# Replace pcard-img usage inside productCardHtml
fn = t.find("function productCardHtml")
fn_end = t.find("\nfunction ", fn + 10)
seg = t[fn:fn_end]
idx = seg.find("pcard-img")
print("before pcard-img:", repr(seg[idx - 40 : idx + 280]))

# Common patterns
candidates = []
# pattern with imgClick
if "${imgClick}" in seg:
    print("has imgClick still")
if "albumFromCard" in seg:
    print("already has albumFromCard")

# Find the template expression for image
import re

m = re.search(
    r"\$\{p\.image\?`<div class=\"pcard-img\"[^`]+`:`<div class=\"pcard-img\">[^`]+`\}",
    seg,
)
if not m:
    # try looser
    m = re.search(r"\$\{p\.image\?`<div class=\"pcard-img\".{0,400}?`\}", seg, re.S)
print("regex match:", bool(m))
if m:
    print("matched:", repr(m.group(0)[:300]))
    old_img = m.group(0)
    new_img = (
        '${cover?`<div class="pcard-img" ${albumFromCard}>'
        "${imgBadge}"
        '<img src="${prodImgUrl(cover)}" loading="lazy" '
        "onerror=\"this.parentElement.innerHTML='📦'\"></div>`:"
        '`<div class="pcard-img">📦</div>`}'
    )
    seg2 = seg.replace(old_img, new_img, 1)
    t = t[:fn] + seg2 + t[fn_end:]
    print("replaced pcard-img")
else:
    # dump around pcard-img for manual
    print("FAIL find image template")

# Verify
checks = {
    "cover in card": "const cover = gallery[0]" in t[t.find("function productCardHtml") : t.find("function productCardHtml") + 2000],
    "albumFromCard": "albumFromCard" in t[t.find("function productCardHtml") : t.find("function productCardHtml") + 2500],
    "img-badge": "img-badge" in t[t.find("function productCardHtml") : t.find("function productCardHtml") + 3500],
    "openProductAlbumFromCard fn": "function openProductAlbumFromCard" in t,
    "productImageList": "function productImageList" in t,
}
print(checks)

p.write_text(t, encoding="utf-8")
print("wrote", p)
