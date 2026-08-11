from pathlib import Path
import re
p = Path("server/public/tbl-enhance.js")
t = p.read_text(encoding="utf-8")
pat = re.compile(
    r"\n    // #region agent log\n    fetch\('http://127\.0\.0\.1:7742/ingest[^;]*;\n    // #endregion",
    re.M,
)
t2, n = pat.subn("", t)
p.write_text(t2, encoding="utf-8")
print("removed", n, "left", t2.count("7742/ingest"))
