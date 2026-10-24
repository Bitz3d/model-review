#!/usr/bin/env python3
"""Owner-invoked helper: lock the intentional Vite dist output for fail-closed deployment."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
FORBIDDEN = {".map", ".blend", ".blend1", ".log", ".env", ".pyc"}

if not DIST.is_dir():
    raise SystemExit("dist/ does not exist; run npm run build first")
entries = []
for path in sorted(DIST.rglob("*")):
    if not path.is_file() or path.is_symlink():
        continue
    relative = path.relative_to(DIST).as_posix()
    if path.suffix.lower() in FORBIDDEN:
        raise SystemExit(f"refusing forbidden dist file: {relative}")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    entries.append({"path": relative, "bytes": path.stat().st_size, "sha256": digest})
if not entries or not any(entry["path"] == "index.html" for entry in entries):
    raise SystemExit("dist output is empty or missing index.html")
(ROOT / "dist-files.json").write_text(json.dumps({"schemaVersion": 1, "files": entries}, indent=2) + "\n", encoding="utf-8")
print(f"locked {len(entries)} dist files")
