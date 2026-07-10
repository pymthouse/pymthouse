#!/usr/bin/env bash
# Copy env vars from a pymthouse-staging pull into pymthouse Preview only.
# Production env records on pymthouse are untouched (preview target removed from
# shared records; production-only records are never deleted).
#
# Usage:
#   vercel link --project pymthouse-staging --yes
#   vercel env pull /tmp/pymthouse-staging.prod.env --environment=production --yes
#   bash scripts/copy-staging-env-to-pymthouse-preview.sh [/tmp/pymthouse-staging.prod.env]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SOURCE_ENV="${1:-/tmp/pymthouse-staging.prod.env}"
DEST_PROJECT_ID="${DEST_PROJECT_ID:-prj_oldvnmdXcGDc7Db5ohPCOUGBZOaG}"
DEST_ENV="${DEST_ENV:-preview}"

if [[ ! -f "$SOURCE_ENV" ]]; then
  echo "Missing source env file: $SOURCE_ENV" >&2
  exit 1
fi

python3 - "$SOURCE_ENV" "$DEST_PROJECT_ID" "$DEST_ENV" "$ROOT" <<'PY'
from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

source_path = Path(sys.argv[1])
project_id = sys.argv[2]
preview_target = sys.argv[3]
root = Path(sys.argv[4])

skip_prefixes = ("VERCEL_", "TURBO_", "NX_")
skip_keys = {"VERCEL"}
sensitive_keys = {
    "DATABASE_URL",
    "NEXTAUTH_SECRET",
    "AUTH_TOKEN_PEPPER",
    "OPENMETER_API_KEY",
    "OPENMETER_INGEST_API_KEY",
    "TURNKEY_API_PRIVATE_KEY",
    "PRIVY_APP_SECRET",
    "GOOGLE_CLIENT_SECRET",
    "GITHUB_CLIENT_SECRET",
}

auth_path = Path.home() / ".local/share/com.vercel.cli/auth.json"
if not auth_path.exists():
    raise SystemExit("Missing Vercel CLI auth. Run: vercel login")
token = json.loads(auth_path.read_text(encoding="utf-8"))["token"]


def parse_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if not match:
            continue
        key, raw = match.group(1), match.group(2)
        if key in skip_keys or any(key.startswith(prefix) for prefix in skip_prefixes):
            continue
        if raw.startswith('"') and raw.endswith('"'):
            raw = raw[1:-1]
        env[key] = raw
    return env


def api(method: str, path: str, body: dict | None = None) -> dict:
    data = None
    headers = {"Authorization": f"Bearer {token}"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        f"https://api.vercel.com{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(req) as resp:
            payload = resp.read().decode("utf-8")
            return json.loads(payload) if payload else {}
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Vercel API {method} {path} failed ({err.code}): {detail}") from err


def list_envs() -> list[dict]:
    payload = api("GET", f"/v9/projects/{project_id}/env")
    envs = payload.get("envs", payload)
    if not isinstance(envs, list):
        raise SystemExit("Unexpected env list payload from Vercel API")
    return envs


source = parse_env_file(source_path)
envs = list_envs()

print(f"Source: {len(source)} app vars from {source_path}")
print(f"Dest: pymthouse ({project_id}) → {preview_target} only")

removed_preview = 0
for item in envs:
    targets = item.get("target") or []
    if preview_target not in targets:
        continue
    env_id = item["id"]
    key = item.get("key", env_id)
    if targets == [preview_target]:
        api("DELETE", f"/v9/projects/{project_id}/env/{env_id}")
        print(f"  deleted preview-only {key}")
        removed_preview += 1
        continue
    new_targets = [t for t in targets if t != preview_target]
    api(
        "PATCH",
        f"/v9/projects/{project_id}/env/{env_id}",
        {"target": new_targets},
    )
    print(f"  detached preview from {key} (kept {new_targets})")
    removed_preview += 1

print(f"Cleared preview from {removed_preview} existing record(s)")

created = 0
for key, value in sorted(source.items()):
    env_type = "sensitive" if key in sensitive_keys else "encrypted"
    api(
        "POST",
        f"/v10/projects/{project_id}/env",
        {
            "key": key,
            "value": value,
            "type": env_type,
            "target": [preview_target],
        },
    )
    print(f"  set {key}")
    created += 1

print(f"Done: {created} preview vars written. Production records unchanged.")
print("Verify: vercel link --project pymthouse --yes && vercel env ls preview")
PY
