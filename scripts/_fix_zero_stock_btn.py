# -*- coding: utf-8 -*-
from pathlib import Path

p = Path("server/public/index.html")
t = p.read_text(encoding="utf-8")
old = """        ${opts.addToCartFn?`<button class="btn sm" style="width:100%;margin-top:8px" onclick="${opts.addToCartFn}(${p.id})">➕ افزودن به سبد${pack>1?` (${pack} عدد)`:''}</button>`:''}"""
new = """        ${opts.addToCartFn?((Number(stockQty)||0)<=0
          ?`<button class="btn sm" style="width:100%;margin-top:8px;opacity:.55" disabled title="موجودی صفر">⛔ بدون موجودی</button>`
          :`<button class="btn sm" style="width:100%;margin-top:8px" onclick="${opts.addToCartFn}(${p.id})">➕ افزودن به سبد${pack>1?` (${pack} عدد)`:''}</button>`):''}"""
if old not in t:
    raise SystemExit("addToCart button not found")
t = t.replace(old, new, 1)
p.write_text(t, encoding="utf-8")
print("zero-stock button OK")
