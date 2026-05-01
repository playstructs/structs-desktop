#!/usr/bin/env python3
"""Patch the app version across config files.

Used by the release workflow to derive the version from the git tag, so
`tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and the root
`package.json` stay in sync without manual bumps before tagging.

Usage: scripts/sync-version.py 0.24.0
"""
import json
import re
import sys
from pathlib import Path


def patch_json(path: Path, version: str) -> None:
    data = json.loads(path.read_text())
    data["version"] = version
    path.write_text(json.dumps(data, indent=2) + "\n")


def patch_cargo_toml(path: Path, version: str) -> None:
    text = path.read_text()
    new = re.sub(
        r'(\[package\][^\[]*?\nversion = ")[^"]*(")',
        rf'\g<1>{version}\g<2>',
        text,
        count=1,
        flags=re.DOTALL,
    )
    if new == text:
        raise RuntimeError(f"no [package] version found in {path}")
    path.write_text(new)


def patch_cargo_lock(path: Path, package: str, version: str) -> None:
    text = path.read_text()
    pattern = re.compile(
        rf'(name = "{re.escape(package)}"\nversion = ")[^"]*(")'
    )
    new, n = pattern.subn(rf'\g<1>{version}\g<2>', text, count=1)
    if n == 0:
        raise RuntimeError(f"no entry for {package} found in {path}")
    path.write_text(new)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: sync-version.py <version>", file=sys.stderr)
        return 2
    version = sys.argv[1]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][\w.\-]+)?", version):
        print(f"invalid semver: {version}", file=sys.stderr)
        return 2

    root = Path(__file__).resolve().parent.parent
    patch_json(root / "src-tauri" / "tauri.conf.json", version)
    patch_json(root / "package.json", version)
    patch_cargo_toml(root / "src-tauri" / "Cargo.toml", version)
    patch_cargo_lock(root / "src-tauri" / "Cargo.lock", "structs-app", version)
    print(f"synced version → {version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
