# -*- coding: utf-8 -*-
from pathlib import Path
import re
import shutil

repo = Path(r"d:\soft\Claud\porje\CursorCrm\crm-taranom")
src = repo / "server"
dst = repo / "android" / "app" / "src" / "main" / "assets" / "nodejs-project" / "server"
skip_re = re.compile(
    r"node_modules|backups|\.db(-wal|-shm)?$|\.env$|public[/\\]releases|public[/\\]uploads|^uploads[/\\]|scripts[/\\]test-|mahak|\.xlsx$|\.xls$",
    re.I,
)

if dst.exists():
    shutil.rmtree(dst)


def copy_dir(s: Path, d: Path, rel: str = ""):
    d.mkdir(parents=True, exist_ok=True)
    for e in s.iterdir():
        r = f"{rel}/{e.name}" if rel else e.name
        if e.name in ("node_modules", "backups") or skip_re.search(r):
            continue
        if e.is_dir():
            copy_dir(e, d / e.name, r)
        elif not re.search(r"\.db(-wal|-shm)?$|^\.env$", e.name):
            shutil.copy2(e, d / e.name)


copy_dir(src, dst)
nav = (dst / "public" / "acc-nav.js").read_text(encoding="utf-8")
sw = (dst / "public" / "sw.js").read_text(encoding="utf-8").splitlines()[1]
print("android synced")
print("has Model A persons", "title: 'اشخاص'" in nav)
print("sw", sw)
print("desktop sw", (repo / "desktop" / "server" / "public" / "sw.js").read_text(encoding="utf-8").splitlines()[1])
