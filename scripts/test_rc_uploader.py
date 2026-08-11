#!/usr/bin/env python3
"""Behavioral tests for the resumable Wave-0 release uploader (no network)."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("rc_uploader", ROOT / "scripts/_deploy-rc-chunked-sftp.py")
assert SPEC and SPEC.loader
uploader = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = uploader
SPEC.loader.exec_module(uploader)


class FakeRemote:
    def __init__(self, files: dict[str, bytes], no_progress: bool = False):
        self.files = files
        self.no_progress = no_progress
        self.upload_calls = 0

    def upload(self, local: Path, remote_path, resume: bool, timeout: int = 1800) -> None:
        self.upload_calls += 1
        if not self.no_progress:
            self.files[str(remote_path)] = local.read_bytes()

    def run(self, command: str, timeout: int = 900) -> str:
        if command.startswith("sha256sum --"):
            for name, data in self.files.items():
                if name in command:
                    return hashlib.sha256(data).hexdigest().upper()
        raise AssertionError(f"unexpected fake command: {command}")


def fake_stat(remote: FakeRemote, path) -> int | None:
    data = remote.files.get(str(path))
    return None if data is None else len(data)


def fake_reset(remote: FakeRemote, artifact) -> None:
    remote.files.pop(str(artifact.staged), None)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path)
    args = parser.parse_args()
    passed = 0

    original_stat = uploader.remote_stat
    original_reset = uploader.reset_stage
    uploader.remote_stat = fake_stat
    uploader.reset_stage = fake_reset
    try:
        with tempfile.TemporaryDirectory(prefix="erp-rc-uploader-") as temp:
            local = Path(temp) / "probe.bin"
            good = b"signed-release-payload"
            local.write_bytes(good)
            artifact = uploader.Artifact(local, "probe.bin", hashlib.sha256(good).hexdigest().upper(), len(good))

            corrupt = b"X" * len(good)
            remote = FakeRemote({str(artifact.staged): corrupt})
            uploader.stage_artifact(remote, artifact)
            assert remote.files[str(artifact.staged)] == good
            assert remote.upload_calls == 1
            passed += 1
            print("  ✅ corrupt full-size stage resets once and recovers")

            partial = good[:5]
            stuck = FakeRemote({str(artifact.staged): partial}, no_progress=True)
            failed = False
            try:
                uploader.stage_artifact(stuck, artifact)
            except RuntimeError as exc:
                failed = "no progress" in str(exc)
            assert failed
            passed += 1
            print("  ✅ zero-progress reput fails closed")
    finally:
        uploader.remote_stat = original_stat
        uploader.reset_stage = original_reset

    if args.source_dir:
        artifacts, manifest = uploader.build_artifacts(args.source_dir.resolve())
        assert manifest["android"]["version"] == "2.0.33"
        assert manifest["desktop"]["version"] == "2.0.10"
        assert len(artifacts) == 5
        passed += 1
        print("  ✅ real APK/EXE/blockmap match manifest + latest.yml SHA-256/SHA-512/size")

    print(f"rc uploader tests: {passed}/{passed} pass")


if __name__ == "__main__":
    main()
