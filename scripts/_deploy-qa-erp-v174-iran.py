#!/usr/bin/env python3
"""SFTP overlay QA-ERP v174 onto Iran. Never wholesale-replace VPS db.js."""
from __future__ import annotations

import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOST, USER, APP = "94.249.244.208", "taranom", "/home/taranom/crm-taranom"
KEY = Path.home() / ".ssh" / "id_ed25519_taranom"
ROOT = Path(__file__).resolve().parents[1]
STAMP_FILE = ".sftp-deploy-stamp-qa-erp-v174"

FILES = [
    "docs/CHANGE-LOG.md",
    ".ai-dos/project/status.md",
    ".ai-dos/tasks/active.yaml",
    ".ai-dos/tasks/handoff.md",
    "docs/qa/FIRST-RUN.md",
    "server/public/app.js",
    "server/public/index.html",
    "server/public/sw.js",
]

OLD_VERIFY = "const result = verifyBackupPackage(req.file.path);"
NEW_MARKER = "const named = uploaded + ext;"


def stamp_hash() -> str:
    return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True).strip()


def run(c, cmd, timeout=300):
    print("==>", cmd[:280])
    _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    text = (out + err).strip()
    print(text[-6000:] if len(text) > 6000 else text)
    print("EXIT", code)
    return code, text


def ensure_dirs(sftp, remote_file: str) -> None:
    parts = remote_file.split("/")[:-1]
    cur = ""
    for p in parts:
        if not p:
            continue
        cur += "/" + p
        try:
            sftp.stat(cur)
        except OSError:
            try:
                sftp.mkdir(cur)
            except OSError:
                pass


def patch_backup_restore(src: str) -> tuple[str, str]:
    if NEW_MARKER in src:
        return src, "already-patched"
    if OLD_VERIFY not in src:
        return src, "pattern-missing"
    old = """app.post('/api/admin/backup-restore', auth, adminOnly, centralOnlyStrict, backupUpload.single('backup'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایل پشتیبان الزامی است' });
  try {
    const { verifyBackupPackage } = require('./backup');
    const result = verifyBackupPackage(req.file.path);
    audit(req.user.id, 'backup_verify', 'system_backup', null, req.file.originalname || 'uploaded backup', req);
    try { fs.unlinkSync(req.file.path); } catch { /* */ }
    res.json({
      success: true,
      data: result,
      message: 'تأیید بسته پشتیبان موفق بود — بازیابی واقعی فقط با CLI آفلاین (restore-backup.js) پس از توقف سرویس',
    });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch { /* */ }
    res.status(400).json({ error: e.message || 'تأیید پشتیبان ناموفق' });
  }
});"""
    new = """app.post('/api/admin/backup-restore', auth, adminOnly, centralOnlyStrict, backupUpload.single('backup'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایل پشتیبان الزامی است' });
  const uploaded = req.file.path;
  const orig = String(req.file.originalname || 'backup.zip');
  const ext = /\\.zip\\.enc$/i.test(orig) ? '.zip.enc'
    : /\\.tar\\.gz\\.enc$/i.test(orig) ? '.tar.gz.enc'
    : /\\.tar\\.gz$/i.test(orig) ? '.tar.gz'
    : (path.extname(orig) || '.zip');
  const named = uploaded + ext;
  try {
    if (named !== uploaded) fs.renameSync(uploaded, named);
    const { verifyBackupPackage } = require('./backup');
    const result = verifyBackupPackage(named);
    audit(req.user.id, 'backup_verify', 'system_backup', null, orig, req);
    try { fs.unlinkSync(named); } catch { /* */ }
    res.json({
      success: true,
      data: result,
      message: 'تأیید بسته پشتیبان موفق بود — بازیابی واقعی فقط با CLI آفلاین (restore-backup.js) پس از توقف سرویس',
    });
  } catch (e) {
    try { fs.unlinkSync(named); } catch { /* */ }
    try { fs.unlinkSync(uploaded); } catch { /* */ }
    res.status(400).json({ error: e.message || 'تأیید پشتیبان ناموفق' });
  }
});"""
    if old not in src:
        return src, "block-mismatch"
    return src.replace(old, new, 1), "patched"


def main() -> None:
    missing = [rel for rel in FILES if not (ROOT / rel).is_file()]
    if missing:
        raise SystemExit(f"missing local files: {missing}")
    if not KEY.is_file():
        raise SystemExit("SSH key missing")
    h = stamp_hash()

    pkey = paramiko.Ed25519Key.from_private_key_file(str(KEY))
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, pkey=pkey, timeout=45, allow_agent=False, look_for_keys=False)

    run(c, f"cd {APP} && git rev-parse --short HEAD && git status -sb | head -8")
    print("skip git pull on dirty VPS tree; SFTP overlay only; never replace db.js")

    sftp = c.open_sftp()
    for rel in FILES:
        local = ROOT / rel
        remote = f"{APP}/{rel.replace(chr(92), '/')}"
        ensure_dirs(sftp, remote)
        print("PUT", rel, local.stat().st_size)
        sftp.put(str(local), remote)

    remote_server = f"{APP}/server/server.js"
    tmp = Path(__file__).with_name("_iran-server.js.tmp")
    sftp.get(remote_server, str(tmp))
    src = tmp.read_text(encoding="utf-8")
    patched, how = patch_backup_restore(src)
    print("SERVER_JS_PATCH", how)
    if how == "patched":
        bak = f"{APP}/server/server.js.bak-v174"
        print("BACKUP", bak)
        sftp.put(str(tmp), bak)
        tmp.write_text(patched, encoding="utf-8", newline="\n")
        sftp.put(str(tmp), remote_server)
        print("PUT surgical server.js backup-restore only")
    tmp.unlink(missing_ok=True)
    sftp.close()

    run(c, "pm2 restart erp-taranom 2>&1 | tail -15")
    _code, health = run(
        c,
        "sleep 8; "
        "curl -sS -o /dev/null -w 'health:%{http_code}\\n' http://127.0.0.1:3000/api/system/health; "
        "curl -sS -o /dev/null -w 'ready:%{http_code}\\n' http://127.0.0.1:3000/api/system/ready; "
        "curl -sS -o /dev/null -w 'root:%{http_code}\\n' http://127.0.0.1:3000/; "
        f"grep -n erp-taranom-v {APP}/server/public/sw.js | head -1",
        timeout=90,
    )
    if "health:200" not in health or "root:200" not in health:
        if how == "patched":
            print("health failed; restoring server.js.bak-v174")
            run(c, f"cp {APP}/server/server.js.bak-v174 {APP}/server/server.js && pm2 restart erp-taranom")
        c.close()
        raise SystemExit("health check failed")
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    run(
        c,
        f"cd {APP} && echo {STAMP_FILE}={stamp} hash={h} > {STAMP_FILE} && cat {STAMP_FILE}",
        timeout=30,
    )
    c.close()
    print("DEPLOY_DONE", h)
    print("STAMP", stamp)


if __name__ == "__main__":
    main()
