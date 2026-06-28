"""Public PymtHouse REST endpoints backing capability discovery.

These two endpoints are unauthenticated and cheap, so the discovery half of the
tool surface never needs a token:

* ``GET /pipeline-catalog``  -> ``{"catalog": [{id, name, models[], regions?}]}``
* ``GET /pipeline-pricing``  -> ``{"pricing": [{orchAddress, orchName?, pipeline,
                                  model, priceWeiPerUnit, pixelsPerUnit, isWarm?}]}``
"""

from __future__ import annotations

from contextlib import nullcontext
from typing import Any

import httpx

from . import config

_TIMEOUT = httpx.Timeout(20.0)


def _request(path: str, params: dict[str, Any] | None, client: httpx.Client | None) -> Any:
    cfg = config.get()
    url = f"{cfg.api_base_url}{path}"
    ctx = nullcontext(client) if client is not None else httpx.Client(timeout=_TIMEOUT)
    with ctx as c:
        resp = c.get(url, params=params, headers={"Accept": "application/json"})
        resp.raise_for_status()
        return resp.json()


def list_capabilities(client: httpx.Client | None = None) -> dict[str, Any]:
    """Summary-level Livepeer capabilities (pipelines + their models)."""
    data = _request("/pipeline-catalog", None, client)
    catalog = data.get("catalog", data) if isinstance(data, dict) else data
    catalog = catalog or []
    return {"capabilities": catalog, "count": len(catalog)}


def discover_by_capability(
    pipeline: str,
    model: str | None = None,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """Concrete providers + pricing for a given pipeline/model."""
    params: dict[str, Any] = {"pipeline": pipeline}
    if model:
        params["model"] = model
    data = _request("/pipeline-pricing", params, client)
    pricing = data.get("pricing", data) if isinstance(data, dict) else data
    pricing = pricing or []
    return {
        "pipeline": pipeline,
        "model": model,
        "providers": pricing,
        "count": len(pricing),
    }
