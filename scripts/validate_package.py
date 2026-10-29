#!/usr/bin/env python3
# 配布資料と既存の例示JSONを検査する。アプリやインフラの試験とは区別する。
"""外部通信や本番の書込を行わず、配布物の整合性を確認する。

JSON Schema Draft 2020-12の一部だけを検査する。完全なSchema検証は
Phase 00で追加したAjvの契約検査へ分担し、この検査単独では合格としない。
"""

from __future__ import annotations

import copy
import datetime as dt
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / "contracts"
EXAMPLES = ROOT / "examples"
EXAMPLE_SCHEMAS = {
    "node.hello.json": "node-envelope.schema.json",
    "recording.manifest.json": "recording-manifest.schema.json",
    "deployment.local.json": "deployment-profile.schema.json",
    "deployment.dual-static.json": "deployment-profile.schema.json",
}
DATE_TIME = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$")
MD_LINK = re.compile(r"\[[^\]]+\]\(([^)\s]+)\)")


def check(condition: bool, message: str, failures: list[str]) -> None:
    if not condition:
        failures.append(message)


def read_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain an object")
    return value


def schema_errors(value: object, schema: dict, root: dict, path: str = "$") -> list[str]:
    """対応する部分集合を検査する。高度なキーワードの確認はAjv側へ分担する。"""
    errors: list[str] = []
    if "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/$defs/"):
            return [f"{path}: unsupported ref {ref!r}"]
        return schema_errors(value, root["$defs"][ref.split("/")[-1]], root, path)

    expected = schema.get("type")
    types = {
        "object": lambda x: isinstance(x, dict),
        "array": lambda x: isinstance(x, list),
        "string": lambda x: isinstance(x, str),
        "integer": lambda x: isinstance(x, int) and not isinstance(x, bool),
        "boolean": lambda x: isinstance(x, bool),
    }
    if expected and not types[expected](value):
        return [f"{path}: expected {expected}"]
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: expected const {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: unknown enum {value!r}")

    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            errors.append(f"{path}: too short")
        if len(value) > schema.get("maxLength", float("inf")):
            errors.append(f"{path}: too long")
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            errors.append(f"{path}: pattern mismatch")
        if schema.get("format") == "date-time":
            if DATE_TIME.fullmatch(value) is None:
                errors.append(f"{path}: invalid UTC/offset datetime")
            else:
                try:
                    dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
                except ValueError:
                    errors.append(f"{path}: impossible date/time")
        if schema.get("format") == "uri":
            parsed = urlparse(value)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                errors.append(f"{path}: invalid http(s) URI")
    if isinstance(value, int) and not isinstance(value, bool):
        if value < schema.get("minimum", float("-inf")):
            errors.append(f"{path}: value below minimum")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}.{key}: required")
        if len(value) > schema.get("maxProperties", float("inf")):
            errors.append(f"{path}: too many properties")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in properties:
                    errors.append(f"{path}.{key}: unexpected property")
        for key, sub_schema in properties.items():
            if key in value:
                errors += schema_errors(value[key], sub_schema, root, f"{path}.{key}")
    if isinstance(value, list):
        item_schema = schema.get("items")
        if item_schema:
            for i, item in enumerate(value):
                errors += schema_errors(item, item_schema, root, f"{path}[{i}]")
        if len(value) > schema.get("maxItems", float("inf")):
            errors.append(f"{path}: too many items")

    for block in schema.get("allOf", []):
        errors += schema_errors(value, block, root, path)
    if "if" in schema:
        if not schema_errors(value, schema["if"], root, path):
            errors += schema_errors(value, schema.get("then", {}), root, path)
        else:
            errors += schema_errors(value, schema.get("else", {}), root, path)
    return errors


def semantic_checks(name: str, obj: dict, failures: list[str]) -> None:
    if name == "recording.manifest.json":
        chunks = obj["chunks"]
        seqs = [c["sequence"] for c in chunks]
        check(seqs == list(range(len(seqs))), "manifest sequence not contiguous/unique", failures)
        base = f"recordings/{obj['recordingId']}/attempts/{obj['attemptId']}/raw/"
        for item in chunks:
            check(item["objectKey"].startswith(base), "manifest objectKey crosses attempt", failures)
            check(item["sizeBytes"] % obj["source"]["packetSize"] == 0, "TS chunk misaligned", failures)
    if name == "node.hello.json":
        issued = dt.datetime.fromisoformat(obj["issuedAt"].replace("Z", "+00:00"))
        expires = dt.datetime.fromisoformat(obj["expiresAt"].replace("Z", "+00:00"))
        check(issued < expires, "node envelope expiry precedes issue", failures)
    if name == "deployment.dual-static.json":
        check(
            obj["frontend"]["primaryOrigin"] != obj["frontend"]["secondaryOrigin"],
            "dual static uses identical origins",
            failures,
        )


def run() -> int:
    failures: list[str] = []
    docs = [
        ROOT / "README.md",
        ROOT / "START_HERE.md",
        ROOT / "PROMPT_FOR_CODEX.md",
        ROOT / "AGENTS.md",
    ]
    docs.extend(ROOT.glob("docs/**/*.md"))
    docs.extend(ROOT.glob("tasks/*.md"))
    docs.extend(ROOT.glob("prompts/*.md"))
    check(len(list(ROOT.glob("tasks/PHASE-*.md"))) == 8, "expected 8 phase files", failures)
    check((ROOT / "AGENTS.md").stat().st_size < 32 * 1024, "AGENTS.md exceeds 32KiB", failures)
    for path in docs:
        text = path.read_text(encoding="utf-8")
        for href in MD_LINK.findall(text):
            if href.startswith(("https://", "http://", "#", "mailto:")):
                continue
            clean = href.split("#", 1)[0]
            if clean and not (path.parent / clean).exists():
                failures.append(f"{path.relative_to(ROOT)}: missing link {href}")

    loaded: dict[str, dict] = {}
    for path in CONTRACTS.glob("*.json"):
        try:
            schema = read_json(path)
            check(schema.get("$schema", "").endswith("2020-12/schema"), f"{path.name}: expected Draft2020-12", failures)
            loaded[path.name] = schema
        except (ValueError, json.JSONDecodeError) as err:
            failures.append(f"{path.name}: {err}")
    required_schemas = {"node-envelope.schema.json", "recording-manifest.schema.json", "capture-permit.schema.json", "deployment-profile.schema.json"}
    check(required_schemas <= loaded.keys(), "missing original contract schemas", failures)

    for example_name, schema_name in EXAMPLE_SCHEMAS.items():
        path = EXAMPLES / example_name
        try:
            obj = read_json(path)
            errors = schema_errors(obj, loaded[schema_name], loaded[schema_name])
            failures.extend(f"{example_name}: {err}" for err in errors)
            if not errors:
                semantic_checks(example_name, obj, failures)
        except (KeyError, ValueError, json.JSONDecodeError) as err:
            failures.append(f"{example_name}: {err}")

    # 未知コマンド、不正なhash、独立した予備配信先がないdual-static構成を拒否する。
    if "node-envelope.schema.json" in loaded:
        event = read_json(EXAMPLES / "node.hello.json")
        invalid = copy.deepcopy(event)
        invalid["type"] = "shell.exec"
        check(bool(schema_errors(invalid, loaded["node-envelope.schema.json"], loaded["node-envelope.schema.json"])), "unknown command accepted", failures)
    if "recording-manifest.schema.json" in loaded:
        manifest = read_json(EXAMPLES / "recording.manifest.json")
        invalid = copy.deepcopy(manifest)
        invalid["chunks"][0]["sha256"] = "not-a-sha256"
        check(bool(schema_errors(invalid, loaded["recording-manifest.schema.json"], loaded["recording-manifest.schema.json"])), "invalid SHA accepted", failures)
    if "deployment-profile.schema.json" in loaded:
        profile = read_json(EXAMPLES / "deployment.dual-static.json")
        invalid = copy.deepcopy(profile)
        invalid["frontend"].pop("secondaryOrigin")
        check(bool(schema_errors(invalid, loaded["deployment-profile.schema.json"], loaded["deployment-profile.schema.json"])), "dual-static missing secondary accepted", failures)

    if failures:
        print(f"FAIL: {len(failures)} issue(s)")
        for issue in failures:
            print(f" - {issue}")
        return 1
    print("PASS: package files, links, selected schema subset, examples, semantic and negative checks")
    print("NOTE: This is not a complete JSON Schema compliance validator or an app/infra test.")
    return 0


if __name__ == "__main__":
    sys.exit(run())
