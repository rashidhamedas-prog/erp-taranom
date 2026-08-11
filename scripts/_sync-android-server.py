# -*- coding: utf-8 -*-
from pathlib import Path
import subprocess

# Deprecated compatibility entry point. The shared Node pipeline owns the
# include/exclude rules and contains no machine-specific paths.
repo = Path(__file__).resolve().parents[1]
subprocess.run(
    ["node", str(repo / "scripts" / "prepare-embedded-server.js"), "android"],
    cwd=repo,
    check=True,
)
