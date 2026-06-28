"""Environment-driven configuration.

Read fresh on every access so the process picks up changes (and tests can
monkeypatch ``os.environ``). A single ``PYMTHOUSE_BASE_URL`` knob drives the
OIDC issuer and REST API base; both can still be overridden explicitly.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

# Defaults mirror livepeer_gateway_client.oidc_auth so that tokens cached by our
# ``login`` tool share a cache key with the SignerTokenProvider used for jobs.
DEFAULT_PYMTHOUSE_BASE_URL = "https://staging.pymthouse.com"
DEFAULT_CLIENT_ID = "livepeer-sdk"
DEFAULT_SCOPES = "openid profile gateway"


def _clean(url: str) -> str:
    return url.strip().rstrip("/")


@dataclass(frozen=True)
class Config:
    pymthouse_base_url: str
    oidc_base_url: str
    api_base_url: str
    client_id: str
    scopes: str
    discovery_url: str | None
    default_model_id: str | None


def get() -> Config:
    base = _clean(os.environ.get("PYMTHOUSE_BASE_URL", DEFAULT_PYMTHOUSE_BASE_URL))
    oidc = _clean(os.environ.get("LIVEPEER_OIDC_BASE_URL", f"{base}/api/v1/oidc"))
    api = _clean(os.environ.get("PYMTHOUSE_API_BASE_URL", f"{base}/api/v1"))
    client_id = os.environ.get("LIVEPEER_CLIENT_ID", DEFAULT_CLIENT_ID).strip()
    scopes = os.environ.get("LIVEPEER_SCOPES", DEFAULT_SCOPES).strip()
    discovery = (os.environ.get("LIVEPEER_DISCOVERY_URL") or "").strip() or None
    model = (os.environ.get("LIVEPEER_MODEL_ID") or "").strip() or None
    return Config(
        pymthouse_base_url=base,
        oidc_base_url=oidc,
        api_base_url=api,
        client_id=client_id,
        scopes=scopes,
        discovery_url=discovery,
        default_model_id=model,
    )
