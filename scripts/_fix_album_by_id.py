# -*- coding: utf-8 -*-
from pathlib import Path

p = Path("server/public/index.html")
t = p.read_text(encoding="utf-8")
old = """  const albumFromCard = gallery.length
    ? `onclick="event.stopPropagation();openProductAlbumFromCard(this)" data-album="${esc(JSON.stringify(gallery))}" style="cursor:zoom-in"`
    : '';"""
new = """  const albumFromCard = gallery.length
    ? `onclick="event.stopPropagation();openProductAlbumFromCard(${p.id})" style="cursor:zoom-in"`
    : '';"""
if old not in t:
    i = t.find("const albumFromCard")
    raise SystemExit(repr(t[i : i + 260]))
t = t.replace(old, new, 1)

# bump marketer-ui cache
t2 = t.replace("/marketer-ui.js?v=70", "/marketer-ui.js?v=71")
if t2 == t and "/marketer-ui.js?v=71" not in t:
    # try other versions
    import re
    t2, n = re.subn(r"/marketer-ui\.js\?v=\d+", "/marketer-ui.js?v=71", t, count=1)
    print("marketer bump via regex", n)
else:
    print("marketer bump", t2 != t or "/marketer-ui.js?v=71" in t2)
t = t2

p.write_text(t, encoding="utf-8")
print("OK album by id")
