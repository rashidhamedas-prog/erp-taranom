# -*- coding: utf-8 -*-
"""Restore pre-Model-A ACC_NAV_SECTIONS (Mahak-style groups) while keeping new resolve keys/items."""
import re
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
repo = Path(r"d:\soft\Claud\porje\CursorCrm\crm-taranom")
path = repo / "server/public/acc-nav.js"

before = subprocess.check_output(
    ["git", "show", "e30b92b^:server/public/acc-nav.js"],
    cwd=repo,
    text=True,
    encoding="utf-8",
    errors="replace",
)
now = path.read_text(encoding="utf-8")


def extract_sections_block(src: str) -> str:
    m = re.search(r"const ACC_NAV_SECTIONS\s*=\s*\[", src)
    if not m:
        raise SystemExit("ACC_NAV_SECTIONS not found")
    i = m.start()
    # find end of array assignment (];)
    bracket = src.find("[", m.start())
    depth = 0
    for j in range(bracket, len(src)):
        if src[j] == "[":
            depth += 1
        elif src[j] == "]":
            depth -= 1
            if depth == 0:
                # include through ];
                end = j + 1
                if end < len(src) and src[end] == ";":
                    end += 1
                return src[i:end]
    raise SystemExit("unclosed ACC_NAV_SECTIONS")


before_secs = extract_sections_block(before)
# Enrich BEFORE sections with items introduced in Model A era
# Insert warehouse report into عملیات انبار (after kardex if present)
if "acc-warehouse-report" not in before_secs:
    before_secs = before_secs.replace(
        "{ id: 'acc-item-kardex', icon: '🗃️', label: 'کاردکس کالا' },",
        "{ id: 'acc-item-kardex', icon: '🗃️', label: 'کاردکس کالا' },\n"
        "      { id: 'acc-warehouse-report', icon: '📊', label: 'گزارش جامع انبار' },",
        1,
    )
if "acc-devices" not in before_secs:
    before_secs = before_secs.replace(
        "{ id: 'acc-settings', icon: '⚙️', label: 'تنظیمات سیستم' },",
        "{ id: 'acc-settings', icon: '⚙️', label: 'تنظیمات سیستم' },\n"
        "      { id: 'acc-devices', icon: '📱', label: 'مدیریت دستگاه‌ها' },",
        1,
    )

# Replace NOW sections with restored BEFORE sections
now_secs = extract_sections_block(now)
if now_secs not in now:
    raise SystemExit("now sections block mismatch")
out = now.replace(now_secs, before_secs, 1)

# Update header comment
out = out.replace(
    "/**\n * ساختار منوی حسابداری — مدل A: سایدبار ماژول‌محور\n"
    " * هر ماژول سرگروه با زیرگروه‌های: اطلاعات پایه / عملیات / گزارشات\n"
    " * ACC_TAB_RESOLVE: نگاشت شناسه منو → handler داخلی loadAccTab\n */",
    "/**\n * ساختار منوی حسابداری — سرگروه‌های عملیاتی (اطلاعات پایه / عملیات / …)\n"
    " * بازگردانی ساختار قبل از Model A به‌درخواست کاربر؛ آیتم‌های جدید حفظ شده‌اند.\n"
    " * ACC_TAB_RESOLVE: نگاشت شناسه منو → handler داخلی loadAccTab\n */",
    1,
)
out = out.replace(
    "/** Model A: module → subgroups (اطلاعات پایه / عملیات / گزارشات) */\n",
    "/** سرگروه‌های منو (flat items per section) */\n",
    1,
)

path.write_text(out, encoding="utf-8", newline="\n")
print("restored ACC_NAV_SECTIONS from pre-Model-A")
# verify titles
titles = re.findall(r"title:\s*'([^']+)'", extract_sections_block(path.read_text(encoding="utf-8")))
print("titles:", titles)
print("has warehouse-report", "acc-warehouse-report" in path.read_text(encoding="utf-8"))
print("has devices", "acc-devices" in path.read_text(encoding="utf-8"))
print("has moadian-hub", "acc-moadian-hub" in path.read_text(encoding="utf-8"))
