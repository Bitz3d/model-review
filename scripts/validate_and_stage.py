#!/usr/bin/env python3
"""Fail-closed validation and staging for the public GitHub Pages artifact."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import math
import os
import re
import shutil
import struct
import sys
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
DIST = ROOT / "dist"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
SHA_RE = re.compile(r"^[a-f0-9]{64}$")
FORBIDDEN_SUFFIXES = {".blend", ".blend1", ".map", ".log", ".pyc", ".env"}
MAX_GIT_FILE = 100_000_000


def fail(message: str) -> None:
    raise ValueError(message)


def sha_file(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def safe_relative(value: object, prefix: str) -> str:
    if not isinstance(value, str) or "\\" in value or value.startswith("/"):
        fail(f"unsafe path: {value!r}")
    path = PurePosixPath(value)
    if not value.startswith(prefix) or any(
        part in {"", ".", ".."} or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", part) is None
        for part in path.parts
    ):
        fail(f"unsafe or out-of-scope path: {value!r}")
    return value


def reject_json_constant(value: str):
    fail(f"non-standard JSON constant is forbidden: {value}")


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail(f"duplicate JSON key is forbidden: {key!r}")
        result[key] = value
    return result


def load_json(value: str | bytes):
    return json.loads(value, parse_constant=reject_json_constant, object_pairs_hook=reject_duplicate_keys)


def exact_keys(value: object, expected: set[str], label: str) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        actual = set(value) if isinstance(value, dict) else set()
        fail(f"{label} keys differ from schema; extra={sorted(actual-expected)}, missing={sorted(expected-actual)}")


def strict_index(value: object, label: str, upper_bound: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value >= upper_bound:
        fail(f"invalid {label} index: {value!r}")
    return value


class ConcatenatedParts(io.RawIOBase):
    def __init__(self, paths: list[Path]):
        self.paths = iter(paths)
        self.current = None

    def readable(self) -> bool:
        return True

    def readinto(self, target) -> int:
        view = memoryview(target)
        while True:
            if self.current is None:
                try:
                    self.current = next(self.paths).open("rb")
                except StopIteration:
                    return 0
            count = self.current.readinto(view)
            if count:
                return count
            self.current.close()
            self.current = None

    def close(self) -> None:
        if self.current is not None:
            self.current.close()
        super().close()


def glb_triangles(json_bytes: bytes) -> tuple[int, list[str]]:
    document = load_json(json_bytes.rstrip(b" \t\r\n\0"))
    asset_version = document.get("asset", {}).get("version")
    if not isinstance(asset_version, str) or not asset_version.startswith("2."):
        fail(f"unsupported glTF asset version: {asset_version!r}")
    required = document.get("extensionsRequired", [])
    if required:
        fail(f"decoder/extensions required but not allowed for this site: {required}")
    for buffer in document.get("buffers", []):
        if "uri" in buffer:
            fail("external GLB buffer dependency is not allowed")
    for image in document.get("images", []):
        if "uri" in image and not str(image["uri"]).startswith("data:"):
            fail("external GLB image dependency is not allowed")
    accessors = document.get("accessors", [])
    mesh_counts = []
    for mesh in document.get("meshes", []):
        count = 0
        for primitive in mesh.get("primitives", []):
            mode = primitive.get("mode", 4)
            if mode != 4:
                fail(f"unsupported non-triangle primitive mode: {mode}")
            accessor_index = primitive.get("indices", primitive.get("attributes", {}).get("POSITION"))
            accessor_index = strict_index(accessor_index, "accessor", len(accessors))
            accessor_count = accessors[accessor_index].get("count")
            if isinstance(accessor_count, bool) or not isinstance(accessor_count, int) or accessor_count < 0:
                fail("primitive accessor has an invalid count")
            count += accessor_count // 3
        mesh_counts.append(count)
    nodes = document.get("nodes", [])
    scenes = document.get("scenes", [])
    if not scenes:
        fail("GLB has no scenes")
    scene_index = strict_index(document.get("scene", 0), "scene", len(scenes))

    def visit(index_value: object, ancestry: set[int]) -> int:
        index = strict_index(index_value, "node", len(nodes))
        if index in ancestry:
            fail("cyclic GLB node graph")
        node = nodes[index]
        total = 0
        if "mesh" in node:
            mesh_index = strict_index(node["mesh"], "mesh", len(mesh_counts))
            total += mesh_counts[mesh_index]
        for child in node.get("children", []):
            total += visit(child, ancestry | {index})
        return total

    total = sum(visit(node, set()) for node in scenes[scene_index].get("nodes", []))
    return total, required


def validate_model(model: dict) -> set[str]:
    exact_keys(model, {"id", "name", "description", "thumbnail", "triangles", "modelScale", "transport", "version", "appearance"}, f"model {model.get('id')!r}")
    transport = model.get("transport")
    exact_keys(transport, {"encoding", "parts", "compressedBytes", "gzipSha256", "decodedBytes", "decodedSha256"}, f"transport for {model.get('id')!r}")
    if transport.get("encoding") != "gzip-parts":
        fail(f"{model.get('id')}: only gzip-parts transport is allowed")
    parts = transport.get("parts")
    if not isinstance(parts, list) or not parts:
        fail(f"{model.get('id')}: parts must be a non-empty list")
    allowed: set[str] = set()
    part_paths: list[Path] = []
    gzip_hash = hashlib.sha256()
    compressed_total = 0
    for part in parts:
        exact_keys(part, {"url", "bytes", "sha256"}, f"transport part for {model.get('id')!r}")
        relative = safe_relative(part.get("url"), "models/")
        if relative in allowed:
            fail(f"duplicate part path: {relative}")
        expected_bytes = part.get("bytes")
        expected_hash = part.get("sha256")
        if not isinstance(expected_bytes, int) or expected_bytes <= 0 or not isinstance(expected_hash, str) or not SHA_RE.fullmatch(expected_hash):
            fail(f"{relative}: invalid bytes/hash metadata")
        path = PUBLIC / relative
        if not path.is_file() or path.is_symlink():
            fail(f"missing or symlinked part: {relative}")
        actual_bytes, actual_hash = sha_file(path)
        if actual_bytes != expected_bytes or actual_hash != expected_hash:
            fail(f"{relative}: size/hash mismatch")
        if actual_bytes >= MAX_GIT_FILE:
            fail(f"{relative}: file is not below the normal 100 MB Git limit")
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                gzip_hash.update(chunk)
        compressed_total += actual_bytes
        part_paths.append(path)
        allowed.add(relative)
    if compressed_total != transport.get("compressedBytes"):
        fail(f"{model['id']}: compressed byte total mismatch")
    if gzip_hash.hexdigest() != transport.get("gzipSha256"):
        fail(f"{model['id']}: concatenated gzip SHA-256 mismatch")

    decoded_hash = hashlib.sha256()
    decoded_size = 0
    prefix = bytearray()
    json_target = None
    raw = ConcatenatedParts(part_paths)
    try:
        with gzip.GzipFile(fileobj=io.BufferedReader(raw), mode="rb") as stream:
            while chunk := stream.read(1024 * 1024):
                decoded_hash.update(chunk)
                decoded_size += len(chunk)
                if json_target is None or len(prefix) < json_target:
                    prefix.extend(chunk)
                    if len(prefix) >= 20 and json_target is None:
                        if prefix[:4] != b"glTF":
                            fail(f"{model['id']}: decoded payload is not GLB")
                        if struct.unpack_from("<I", prefix, 4)[0] != 2:
                            fail(f"{model['id']}: decoded payload is not GLB version 2")
                        declared = struct.unpack_from("<I", prefix, 8)[0]
                        if declared != transport.get("decodedBytes"):
                            fail(f"{model['id']}: GLB declared byte length mismatch")
                        json_length, chunk_type = struct.unpack_from("<II", prefix, 12)
                        if chunk_type != 0x4E4F534A:
                            fail(f"{model['id']}: first GLB chunk is not JSON")
                        json_target = 20 + json_length
                    if json_target is not None and len(prefix) > json_target:
                        del prefix[json_target:]
    finally:
        raw.close()
    if decoded_size != transport.get("decodedBytes") or decoded_hash.hexdigest() != transport.get("decodedSha256"):
        fail(f"{model['id']}: decoded size/SHA-256 mismatch")
    if json_target is None or len(prefix) < json_target:
        fail(f"{model['id']}: incomplete GLB JSON chunk")
    triangles, _ = glb_triangles(bytes(prefix[20:json_target]))
    if triangles != model.get("triangles"):
        fail(f"{model['id']}: triangle count {triangles} != manifest {model.get('triangles')}")

    thumbnail = safe_relative(model.get("thumbnail"), "previews/")
    thumb_path = PUBLIC / thumbnail
    if not thumb_path.is_file() or thumb_path.is_symlink():
        fail(f"missing or symlinked thumbnail: {thumbnail}")
    if thumb_path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
        fail(f"unsupported thumbnail type: {thumbnail}")
    if thumb_path.stat().st_size >= MAX_GIT_FILE:
        fail(f"thumbnail too large: {thumbnail}")
    allowed.add(thumbnail)
    return allowed


def validate_public() -> tuple[dict, set[str]]:
    manifest_path = PUBLIC / "models.json"
    if not manifest_path.is_file() or manifest_path.is_symlink():
        fail("public/models.json must be a regular non-symlink file")
    manifest = load_json(manifest_path.read_text("utf-8"))
    exact_keys(manifest, {"schemaVersion", "activeModel", "models"}, "models manifest")
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("models"), list) or not manifest["models"]:
        fail("unsupported/empty public/models.json")
    ids: set[str] = set()
    allowed = {"models.json"}
    for model in manifest["models"]:
        exact_keys(model, {"id", "name", "description", "thumbnail", "triangles", "modelScale", "transport", "version", "appearance"}, "model entry")
        model_id = model.get("id")
        if not isinstance(model_id, str) or not ID_RE.fullmatch(model_id) or model_id in ids:
            fail(f"invalid/duplicate model id: {model_id!r}")
        ids.add(model_id)
        if not isinstance(model.get("name"), str) or not isinstance(model.get("description"), str):
            fail(f"{model_id}: missing public labels")
        model_scale = model.get("modelScale")
        if isinstance(model_scale, bool) or not isinstance(model_scale, (int, float)) or not math.isfinite(model_scale) or model_scale <= 0:
            fail(f"{model_id}: invalid modelScale")
        allowed |= validate_model(model)
    if manifest.get("activeModel") not in ids:
        fail("activeModel does not identify a listed model")
    actual = {path.relative_to(PUBLIC).as_posix() for path in PUBLIC.rglob("*") if path.is_file() or path.is_symlink()}
    if actual != allowed:
        fail(f"public/ must contain only manifest-listed files; extra={sorted(actual-allowed)}, missing={sorted(allowed-actual)}")
    return manifest, allowed


def validate_dist() -> list[dict]:
    lock_path = ROOT / "dist-files.json"
    lock = load_json(lock_path.read_text("utf-8"))
    exact_keys(lock, {"schemaVersion", "files"}, "dist lock")
    if lock.get("schemaVersion") != 1:
        fail("unsupported dist lock schema")
    entries = lock.get("files")
    if not isinstance(entries, list) or not entries:
        fail("dist-files.json has no files")
    allowed = set()
    for entry in entries:
        exact_keys(entry, {"path", "bytes", "sha256"}, "dist lock entry")
        relative = entry.get("path")
        if not isinstance(relative, str) or PurePosixPath(relative).is_absolute() or any(part in {"", ".", ".."} for part in PurePosixPath(relative).parts):
            fail(f"unsafe dist path: {relative!r}")
        if relative in allowed or Path(relative).suffix.lower() in FORBIDDEN_SUFFIXES:
            fail(f"duplicate/forbidden dist path: {relative}")
        path = DIST / relative
        if not path.is_file() or path.is_symlink():
            fail(f"missing or symlinked dist file: {relative}")
        size, digest = sha_file(path)
        if size != entry.get("bytes") or digest != entry.get("sha256"):
            fail(f"dist lock mismatch: {relative}")
        if size >= MAX_GIT_FILE:
            fail(f"dist file too large: {relative}")
        allowed.add(relative)
    actual = {path.relative_to(DIST).as_posix() for path in DIST.rglob("*") if path.is_file() or path.is_symlink()}
    if actual != allowed:
        fail(f"dist/ differs from lock; extra={sorted(actual-allowed)}, missing={sorted(allowed-actual)}")
    return entries


def stage(output: Path, dist_entries: list[dict], public_allowed: set[str]) -> None:
    output = output.resolve()
    if output.exists():
        fail(f"output already exists: {output}")
    if output == ROOT or ROOT not in output.parents:
        fail("output must be a new directory inside the checkout")
    output.mkdir(parents=True)
    for entry in dist_entries:
        source = DIST / entry["path"]
        target = output / entry["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    for relative in sorted(public_allowed):
        source = PUBLIC / relative
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    (output / ".nojekyll").write_text("", encoding="utf-8")
    staged = {path.relative_to(output).as_posix() for path in output.rglob("*") if path.is_file()}
    expected = {entry["path"] for entry in dist_entries} | public_allowed | {".nojekyll"}
    if staged != expected:
        fail(f"staged artifact allowlist mismatch: {sorted(staged ^ expected)}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    _, public_allowed = validate_public()
    dist_entries = validate_dist()
    stage(args.output, dist_entries, public_allowed)
    print(f"validated and staged {len(public_allowed) + len(dist_entries) + 1} allowlisted files in {args.output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError, gzip.BadGzipFile) as error:
        print(f"validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
