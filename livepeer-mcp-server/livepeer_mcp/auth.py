"""Device-code authentication against PymtHouse.

Thin wrapper over ``livepeer_gateway_client.oidc_auth``. The underlying library
already handles the RFC 8628 device flow, token caching (``~/.cache/
livepeer-gateway-client/tokens``) and refresh; we only adapt it to the
request/response shape of MCP tools:

* ``begin_login`` starts ``device_login`` on a background thread and returns the
  verification URL + user code as soon as the device authorization response
  arrives, instead of blocking the tool call for the full poll loop.
* ``status`` / ``require_token`` give the tools a clean, seamless auth gate.

The heavy ``livepeer_gateway_client`` import (pulls in PyAV) is done lazily so
the rest of the package stays importable without it.
"""

from __future__ import annotations

import threading
from typing import Any

from . import config


class AuthRequiredError(RuntimeError):
    """Raised when a tool needs a token but the user has not logged in."""


def _oidc():  # lazy import
    from livepeer_gateway_client import oidc_auth

    return oidc_auth


# --- background login state -------------------------------------------------

_lock = threading.Lock()
_state: dict[str, Any] = {
    "status": "idle",  # idle | pending | authenticated | error
    "verification_uri": None,
    "user_code": None,
    "expires_in": None,
    "error": None,
}
_thread: threading.Thread | None = None
_ready = threading.Event()


def _reset_state() -> None:
    _state.update(
        status="starting",
        verification_uri=None,
        user_code=None,
        expires_in=None,
        error=None,
    )


def _run_login(base_url: str, client_id: str, scopes: str) -> None:
    oidc = _oidc()

    def on_device_auth(auth_url: str, user_code: str, expires_in: int) -> None:
        with _lock:
            _state.update(
                status="pending",
                verification_uri=auth_url,
                user_code=user_code,
                expires_in=expires_in,
            )
        _ready.set()

    try:
        oidc.device_login(
            base_url,
            client_id=client_id,
            scopes=scopes,
            on_device_auth=on_device_auth,
        )
        with _lock:
            _state.update(status="authenticated")
    except Exception as exc:  # noqa: BLE001 - surfaced to the tool caller
        with _lock:
            _state.update(status="error", error=str(exc))
    finally:
        _ready.set()


def _load_token():
    cfg = config.get()
    return _oidc().load_cached_token(
        cfg.oidc_base_url, client_id=cfg.client_id, scopes=cfg.scopes
    )


def _is_authenticated() -> bool:
    token = _load_token()
    if token is None:
        return False
    is_expired = getattr(token, "is_expired", None)
    try:
        return not (callable(is_expired) and is_expired())
    except Exception:  # noqa: BLE001
        return True


def begin_login(wait_seconds: float = 20.0) -> dict[str, Any]:
    """Start (or resume) a device-code login and return verification details."""
    global _thread

    if _is_authenticated():
        with _lock:
            _state.update(status="authenticated")
        return status()

    cfg = config.get()
    with _lock:
        already_pending = (
            _thread is not None
            and _thread.is_alive()
            and _state["verification_uri"] is not None
        )
        if not already_pending:
            _reset_state()
            _ready.clear()
            _thread = threading.Thread(
                target=_run_login,
                args=(cfg.oidc_base_url, cfg.client_id, cfg.scopes),
                daemon=True,
            )
            _thread.start()

    # Wait only until the device authorization response (URL + code) is ready.
    _ready.wait(timeout=wait_seconds)
    snap = status()
    if snap["status"] in ("pending", "authenticated"):
        snap["message"] = (
            "Visit the verification URL and enter the code to finish signing in. "
            "Call auth_status to confirm."
        )
    elif snap["status"] == "error":
        snap["message"] = f"Login failed: {snap.get('error')}"
    else:
        snap["message"] = "Login is starting; call auth_status shortly."
    return snap


def status() -> dict[str, Any]:
    with _lock:
        snap = dict(_state)
    if _is_authenticated():
        snap["status"] = "authenticated"
    snap["authenticated"] = snap["status"] == "authenticated"
    return snap


def require_token() -> str:
    """Return a valid access token, refreshing if needed.

    Raises :class:`AuthRequiredError` if no usable token exists. Never triggers
    an interactive prompt (``headless=True``).
    """
    cfg = config.get()
    oidc = _oidc()
    try:
        token = oidc.ensure_valid_token(
            cfg.oidc_base_url,
            client_id=cfg.client_id,
            scopes=cfg.scopes,
            headless=True,
        )
    except Exception as exc:  # noqa: BLE001 - convert to a clean auth gate
        raise AuthRequiredError(
            "Not authenticated. Call the `login` tool, approve at the "
            f"verification URL, then retry. ({exc})"
        ) from exc

    access = getattr(token, "access_token", None) or (
        token.get("access_token") if isinstance(token, dict) else None
    )
    if not access:
        raise AuthRequiredError("Not authenticated. Call the `login` tool first.")
    return access


def logout() -> dict[str, Any]:
    cfg = config.get()
    _oidc().clear_cached_token(
        cfg.oidc_base_url, client_id=cfg.client_id, scopes=cfg.scopes
    )
    with _lock:
        _state.update(
            status="idle",
            verification_uri=None,
            user_code=None,
            expires_in=None,
            error=None,
        )
    return {"status": "logged_out", "authenticated": False}
