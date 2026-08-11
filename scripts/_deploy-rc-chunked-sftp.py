#!/usr/bin/env python3
"""Resumable, verify-before-promote upload for signed Wave-0 RC artifacts."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
APP = PurePosixPath("/home/taranom/crm-taranom")
RELEASES = APP / "server/public/releases"
@dataclass(frozen=True)
class Artifact:
    local: Path
    remote_name: str
    sha256: str
    size: int

    @property
    def remote(self) -> PurePosixPath:
        return RELEASES / self.remote_name

    @property
    def staged(self) -> PurePosixPath:
        return RELEASES / f".{self.remote_name}.part.{self.sha256.lower()}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="94.249.244.208")
    parser.add_argument("--port", type=int, default=22)
    parser.add_argument("--user", default="taranom")
    parser.add_argument("--key", type=Path, default=Path.home() / ".ssh" / "id_ed25519_taranom")
    parser.add_argument("--known-hosts", type=Path, default=Path.home() / ".ssh" / "known_hosts")
    parser.add_argument("--source-dir", type=Path, default=ROOT / "server/public/releases")
    parser.add_argument("--ssh", default="ssh.exe" if os.name == "nt" else "ssh")
    parser.add_argument("--sftp", default="sftp.exe" if os.name == "nt" else "sftp")
    parser.add_argument(
        "--recover-stale-lock-minutes", type=int, default=0,
        help="explicitly remove a release lock older than this many minutes (0 = never steal)",
    )
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest().upper()


def sha512_file(path: Path) -> str:
    digest = hashlib.sha512()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return base64.b64encode(digest.digest()).decode("ascii")


def find_source(source_dir: Path, names: list[str]) -> Path:
    for name in names:
        candidate = source_dir / name
        if candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError(f"none of these release files exist in {source_dir}: {', '.join(names)}")


def build_artifacts(source_dir: Path) -> tuple[list[Artifact], dict]:
    manifest_path = ROOT / "server/public/releases/manifest.json"
    latest_path = ROOT / "server/public/releases/latest.yml"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    latest = latest_path.read_text(encoding="utf-8")
    android = manifest["android"]
    desktop = manifest["desktop"]
    if android["version"] != "2.0.33" or desktop["version"] != "2.0.10":
        raise RuntimeError("manifest versions are not the expected Wave-0 RC 2.0.33/2.0.10")

    apk = find_source(source_dir, ["erp-taranom-2.0.33.apk", "erp-taranom-signed.apk", "erp-taranom.apk"])
    exe = find_source(source_dir, ["ERP-Taranom-Setup-2.0.10-signed.exe", "ERP-Taranom-Setup-2.0.10.exe"])
    blockmap = find_source(source_dir, ["ERP-Taranom-Setup-2.0.10.exe.blockmap"])

    import re
    latest_version = re.search(r"^version:\s*(\S+)\s*$", latest, re.MULTILINE)
    latest_path_value = re.search(r"^path:\s*(.+?)\s*$", latest, re.MULTILINE)
    latest_size = re.search(r"^\s*size:\s*(\d+)\s*$", latest, re.MULTILINE)
    latest_sha512 = re.search(r"^sha512:\s*(\S+)\s*$", latest, re.MULTILINE)
    if not all((latest_version, latest_path_value, latest_size, latest_sha512)):
        raise RuntimeError("latest.yml is missing version/path/size/SHA-512")
    expected_alias = "ERP Taranom Setup 2.0.10.exe"
    actual_sha512 = sha512_file(exe)
    if (
        latest_version.group(1) != desktop["version"]
        or latest_path_value.group(1) != expected_alias
        or int(latest_size.group(1)) != int(desktop["size"])
        or latest_sha512.group(1) != desktop.get("sha512")
        or actual_sha512 != desktop.get("sha512")
    ):
        raise RuntimeError("desktop EXE, manifest.json, and latest.yml metadata do not match")
    if blockmap.stat().st_size <= 0:
        raise RuntimeError("desktop blockmap is empty")

    expected = [
        (apk, "erp-taranom.apk", str(android["sha256"]).upper(), int(android["size"])),
        (exe, "ERP-Taranom-Setup-2.0.10.exe", str(desktop["sha256"]).upper(), int(desktop["size"])),
    ]
    artifacts: list[Artifact] = []
    for local, remote_name, digest, size in expected:
        got_size = local.stat().st_size
        got_digest = sha256_file(local)
        if got_size != size or got_digest != digest:
            raise RuntimeError(
                f"local release mismatch for {local.name}: size={got_size}/{size} sha256={got_digest}/{digest}"
            )
        artifacts.append(Artifact(local, remote_name, digest, size))

    for local, remote_name in [
        (blockmap, "ERP Taranom Setup 2.0.10.exe.blockmap"),
        (latest_path, "latest.yml"),
        (manifest_path, "manifest.json"),
    ]:
        artifacts.append(Artifact(local.resolve(), remote_name, sha256_file(local), local.stat().st_size))
    return artifacts, manifest


class Remote:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        if not self.args.key.is_file():
            raise FileNotFoundError(f"SSH key missing: {self.args.key}")
        if not self.args.known_hosts.is_file():
            raise FileNotFoundError(f"pinned known_hosts missing: {self.args.known_hosts}")
        if not shutil.which(self.args.ssh):
            raise FileNotFoundError(f"ssh executable missing: {self.args.ssh}")
        if not shutil.which(self.args.sftp):
            raise FileNotFoundError(f"sftp executable missing: {self.args.sftp}")
        for unsafe in (str(self.args.key), str(self.args.known_hosts)):
            if "\n" in unsafe or "\r" in unsafe or '"' in unsafe:
                raise ValueError("SSH paths may not contain quotes or newlines")

    def common(self) -> list[str]:
        return [
            "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=yes",
            "-o", "IdentitiesOnly=yes",
            "-o", "ClearAllForwardings=yes",
            "-o", f"UserKnownHostsFile={self.args.known_hosts}",
            "-o", "ConnectTimeout=30",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            "-i", str(self.args.key),
        ]

    def run(self, command: str, timeout: int = 900) -> str:
        cmd = [
            self.args.ssh, *self.common(), "-p", str(self.args.port),
            f"{self.args.user}@{self.args.host}", command,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
        if result.returncode != 0:
            raise RuntimeError(
                f"remote command failed ({result.returncode}): {(result.stderr or result.stdout).strip()[:1200]}"
            )
        return result.stdout.strip()

    def upload(self, local: Path, remote_path: PurePosixPath, resume: bool, timeout: int = 1800) -> None:
        if '"' in str(local) or '"' in str(remote_path):
            raise ValueError("SFTP paths may not contain quotes")
        verb = "reput" if resume else "put"
        batch = f'{verb} "{local}" "{remote_path}"\n'
        cmd = [
            self.args.sftp, *self.common(), "-P", str(self.args.port), "-b", "-",
            f"{self.args.user}@{self.args.host}",
        ]
        result = subprocess.run(cmd, input=batch, capture_output=True, text=True, timeout=timeout, check=False)
        if result.returncode != 0:
            raise RuntimeError(
                f"sftp {verb} failed ({result.returncode}): {(result.stderr or result.stdout).strip()[:1200]}"
            )


def remote_stat(remote: Remote, path: PurePosixPath) -> int | None:
    quoted = shlex.quote(str(path))
    value = remote.run(f"if [ -f {quoted} ]; then stat -c %s -- {quoted}; else printf MISSING; fi")
    if value == "MISSING":
        return None
    if not value.isdigit():
        raise RuntimeError(f"invalid remote stat response for {path}: {value}")
    return int(value)


def reset_stage(remote: Remote, artifact: Artifact) -> None:
    remote.run(f"rm -f -- {shlex.quote(str(artifact.staged))}")


def stage_artifact(remote: Remote, artifact: Artifact) -> None:
    print(f"STAGE {artifact.local.name} size={artifact.size} sha256={artifact.sha256}")
    while True:
        offset = remote_stat(remote, artifact.staged) or 0
        if offset > artifact.size:
            print(f"  stale oversized stage ({offset}); resetting")
            reset_stage(remote, artifact)
            offset = 0
        if offset == artifact.size:
            break
        for attempt in range(1, 6):
            try:
                remote.upload(artifact.local, artifact.staged, resume=(offset > 0))
                break
            except Exception as exc:  # ambiguous disconnect: remote size is reconciled next
                print(f"  reput attempt {attempt} interrupted: {type(exc).__name__}: {exc}")
                if attempt == 5:
                    raise
                time.sleep(2 * attempt)

        committed = remote_stat(remote, artifact.staged)
        if committed is None or committed < offset or committed > artifact.size:
            raise RuntimeError(f"invalid remote stage size after write: {committed}")
        if committed <= offset:
            raise RuntimeError(f"SFTP reput made no progress at offset {offset}: {artifact.remote_name}")
        print(f"  {committed}/{artifact.size} ({100 * committed / artifact.size:.1f}%)")

    quoted = shlex.quote(str(artifact.staged))
    got = remote.run(f"sha256sum -- {quoted} | awk '{{print toupper($1)}}'", timeout=900)
    if got != artifact.sha256:
        print(f"  corrupt full-size stage detected; resetting once: {got}")
        reset_stage(remote, artifact)
        remote.upload(artifact.local, artifact.staged, resume=False)
        if remote_stat(remote, artifact.staged) != artifact.size:
            raise RuntimeError(f"remote staged size mismatch after clean retry for {artifact.remote_name}")
        got = remote.run(f"sha256sum -- {quoted} | awk '{{print toupper($1)}}'", timeout=900)
        if got != artifact.sha256:
            raise RuntimeError(f"remote staged SHA-256 mismatch after clean retry for {artifact.remote_name}: {got}")
    if remote_stat(remote, artifact.staged) != artifact.size:
        raise RuntimeError(f"remote staged size mismatch for {artifact.remote_name}")
    print(f"VERIFIED {artifact.remote_name}")


def promote_all(remote: Remote, artifacts: list[Artifact], session: str) -> dict[str, PurePosixPath | None]:
    backups: dict[str, PurePosixPath | None] = {}
    for artifact in artifacts:
        rollback_path = RELEASES / f".{artifact.remote_name}.rollback.{session}"
        if remote_stat(remote, artifact.remote) is not None:
            remote.run(f"cp -p -- {shlex.quote(str(artifact.remote))} {shlex.quote(str(rollback_path))}")
            backups[artifact.remote_name] = rollback_path
        else:
            backups[artifact.remote_name] = None

    promoted: list[Artifact] = []
    try:
        for artifact in artifacts:
            remote.run(
                f"mv -f -- {shlex.quote(str(artifact.staged))} {shlex.quote(str(artifact.remote))}"
            )
            promoted.append(artifact)
        return backups
    except Exception:
        rollback(remote, promoted, backups)
        raise


def rollback(remote: Remote, artifacts: list[Artifact], backups: dict[str, PurePosixPath | None]) -> None:
    failures: list[str] = []
    for artifact in reversed(artifacts):
        try:
            previous = backups.get(artifact.remote_name)
            if previous is None:
                remote.run(f"rm -f -- {shlex.quote(str(artifact.remote))}")
                if remote_stat(remote, artifact.remote) is not None:
                    raise RuntimeError("new artifact still exists after rollback")
            else:
                expected = remote.run(
                    f"sha256sum -- {shlex.quote(str(previous))} | awk '{{print toupper($1)}}'"
                )
                remote.run(f"mv -f -- {shlex.quote(str(previous))} {shlex.quote(str(artifact.remote))}")
                got = remote.run(
                    f"sha256sum -- {shlex.quote(str(artifact.remote))} | awk '{{print toupper($1)}}'"
                )
                if got != expected:
                    raise RuntimeError("restored artifact hash mismatch")
        except Exception as exc:
            failures.append(f"{artifact.remote_name}: {exc}")
    if failures:
        raise RuntimeError("rollback incomplete: " + " | ".join(failures))


def smoke(remote: Remote, manifest: dict, artifacts: list[Artifact]) -> None:
    android = manifest["android"]
    desktop = manifest["desktop"]
    check = (
        "import json; p='/home/taranom/crm-taranom/server/public/releases/manifest.json'; "
        "d=json.load(open(p, encoding='utf-8')); "
        f"assert d['android']['version']=={android['version']!r}; "
        f"assert d['android']['sha256'].upper()=={str(android['sha256']).upper()!r}; "
        f"assert int(d['android']['size'])=={int(android['size'])}; "
        f"assert d['desktop']['version']=={desktop['version']!r}; "
        f"assert d['desktop']['sha256'].upper()=={str(desktop['sha256']).upper()!r}; "
        f"assert int(d['desktop']['size'])=={int(desktop['size'])}; print('manifest-ok')"
    )
    remote.run(f"python3 -c {shlex.quote(check)}")

    by_name = {a.remote_name: a for a in artifacts}
    for name, url in [
        ("erp-taranom.apk", "http://127.0.0.1:3000/releases/erp-taranom.apk"),
        ("ERP-Taranom-Setup-2.0.10.exe", "http://127.0.0.1:3000/releases/ERP-Taranom-Setup-2.0.10.exe"),
    ]:
        expected = by_name[name].sha256
        command = f"set -o pipefail; curl -fsS --max-time 900 {shlex.quote(url)} | sha256sum | awk '{{print toupper($1)}}'"
        got = remote.run(f"bash -lc {shlex.quote(command)}", timeout=1000)
        if got != expected:
            raise RuntimeError(f"HTTP SHA-256 mismatch for {name}: {got}")


def rollback_aliases(remote: Remote, backups: dict[str, PurePosixPath | None]) -> None:
    failures: list[str] = []
    for alias, previous in reversed(list(backups.items())):
        target = RELEASES / alias
        try:
            if previous is None:
                remote.run(f"rm -f -- {shlex.quote(str(target))}")
                if remote_stat(remote, target) is not None:
                    raise RuntimeError("new alias still exists after rollback")
            else:
                expected = remote.run(
                    f"sha256sum -- {shlex.quote(str(previous))} | awk '{{print toupper($1)}}'"
                )
                remote.run(f"mv -f -- {shlex.quote(str(previous))} {shlex.quote(str(target))}")
                got = remote.run(
                    f"sha256sum -- {shlex.quote(str(target))} | awk '{{print toupper($1)}}'"
                )
                if got != expected:
                    raise RuntimeError("restored alias hash mismatch")
        except Exception as exc:
            failures.append(f"{alias}: {exc}")
    if failures:
        raise RuntimeError("alias rollback incomplete: " + " | ".join(failures))


def create_aliases(remote: Remote, session: str) -> dict[str, PurePosixPath | None]:
    pairs = [
        (RELEASES / "erp-taranom.apk", RELEASES / "crm-taranom.apk"),
        (RELEASES / "ERP-Taranom-Setup-2.0.10.exe", RELEASES / "ERP Taranom Setup 2.0.10.exe"),
    ]
    backups: dict[str, PurePosixPath | None] = {}
    for _source, target in pairs:
        previous = RELEASES / f".{target.name}.rollback.{session}"
        if remote_stat(remote, target) is not None:
            remote.run(f"cp -p -- {shlex.quote(str(target))} {shlex.quote(str(previous))}")
            backups[target.name] = previous
        else:
            backups[target.name] = None
    try:
        for source, target in pairs:
            temp = PurePosixPath(str(target) + f".tmp.{session}")
            remote.run(
                f"cp -p -- {shlex.quote(str(source))} {shlex.quote(str(temp))} && "
                f"mv -f -- {shlex.quote(str(temp))} {shlex.quote(str(target))}"
            )
        return backups
    except Exception:
        rollback_aliases(remote, backups)
        raise


def verify_aliases(remote: Remote, artifacts: list[Artifact]) -> None:
    by_name = {a.remote_name: a for a in artifacts}
    for canonical, alias, url in [
        ("erp-taranom.apk", "crm-taranom.apk", "http://127.0.0.1:3000/releases/crm-taranom.apk"),
        ("ERP-Taranom-Setup-2.0.10.exe", "ERP Taranom Setup 2.0.10.exe", "http://127.0.0.1:3000/releases/ERP%20Taranom%20Setup%202.0.10.exe"),
    ]:
        expected = by_name[canonical].sha256
        got = remote.run(
            f"sha256sum -- {shlex.quote(str(RELEASES / alias))} | awk '{{print toupper($1)}}'"
        )
        if got != expected:
            raise RuntimeError(f"alias SHA-256 mismatch: {alias}")
        command = f"set -o pipefail; curl -fsS --max-time 900 {shlex.quote(url)} | sha256sum | awk '{{print toupper($1)}}'"
        http_got = remote.run(f"bash -lc {shlex.quote(command)}", timeout=1000)
        if http_got != expected:
            raise RuntimeError(f"alias HTTP SHA-256 mismatch: {alias}")


def cleanup(remote: Remote, artifacts: list[Artifact], backups: dict[str, PurePosixPath | None]) -> None:
    paths = [p for p in backups.values() if p is not None]
    paths.extend(a.staged for a in artifacts)
    if paths:
        remote.run("rm -f -- " + " ".join(shlex.quote(str(p)) for p in paths))


def acquire_lock(remote: Remote, lock: PurePosixPath, session: str, stale_minutes: int) -> None:
    if stale_minutes < 0:
        raise ValueError("--recover-stale-lock-minutes cannot be negative")
    command = (
        f"mkdir -- {shlex.quote(str(lock))} && "
        f"printf '%s\\n' {shlex.quote(session)} > {shlex.quote(str(lock / 'owner'))}"
    )
    try:
        remote.run(command)
        return
    except RuntimeError:
        if stale_minutes == 0:
            raise RuntimeError(
                "remote release lock exists; verify no uploader is active, then rerun with "
                "--recover-stale-lock-minutes <age>"
            )
    seconds = stale_minutes * 60
    recover = (
        f"set -eu; test -d {shlex.quote(str(lock))}; "
        f"age=$(( $(date +%s) - $(stat -c %Y -- {shlex.quote(str(lock))}) )); "
        f"test \"$age\" -ge {seconds}; "
        f"owner=$(cat {shlex.quote(str(lock / 'owner'))} 2>/dev/null || true); "
        f"test \"$owner\" != {shlex.quote(session)}; rm -rf -- {shlex.quote(str(lock))}"
    )
    remote.run(recover)
    remote.run(command)


def main() -> None:
    args = parse_args()
    artifacts, manifest = build_artifacts(args.source_dir.resolve())
    remote = Remote(args)
    lock = RELEASES / ".rc-upload.lock"
    session = f"{int(time.time())}-{os.getpid()}"
    acquire_lock(remote, lock, session, args.recover_stale_lock_minutes)
    backups: dict[str, PurePosixPath | None] = {}
    alias_backups: dict[str, PurePosixPath | None] = {}
    promoted = False
    try:
        for artifact in artifacts:
            stage_artifact(remote, artifact)
        backups = promote_all(remote, artifacts, session)
        promoted = True
        try:
            smoke(remote, manifest, artifacts)
        except Exception:
            rollback(remote, artifacts, backups)
            promoted = False
            raise
        try:
            alias_backups = create_aliases(remote, session)
            verify_aliases(remote, artifacts)
        except Exception as original:
            rollback_errors: list[str] = []
            if alias_backups:
                try:
                    rollback_aliases(remote, alias_backups)
                except Exception as exc:
                    rollback_errors.append(str(exc))
            try:
                rollback(remote, artifacts, backups)
            except Exception as exc:
                rollback_errors.append(str(exc))
            promoted = False
            if rollback_errors:
                raise RuntimeError(f"publish failed: {original}; rollback errors: {' | '.join(rollback_errors)}") from original
            raise
        cleanup(remote, artifacts, backups)
        for previous in alias_backups.values():
            if previous is not None:
                remote.run(f"rm -f -- {shlex.quote(str(previous))}")
        print("DONE: all artifacts staged, verified, atomically promoted, and HTTP-hash checked")
    finally:
        if not promoted:
            for artifact in artifacts:
                try:
                    if remote_stat(remote, artifact.staged) not in (None, artifact.size):
                        print(f"retained resumable stage: {artifact.staged}")
                except Exception:
                    pass
        try:
            release = (
                f"set -eu; owner=$(cat {shlex.quote(str(lock / 'owner'))}); "
                f"test \"$owner\" = {shlex.quote(session)}; rm -rf -- {shlex.quote(str(lock))}"
            )
            remote.run(release)
        except Exception as exc:
            print(f"WARNING: could not release remote lock: {exc}", file=sys.stderr)


if __name__ == "__main__":
    main()
