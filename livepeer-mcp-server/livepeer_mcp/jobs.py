"""Live (lv2v) job runner over the Livepeer gateway client.

A "job" here is a live video-to-video streaming session: ``connect`` negotiates
a payment session with an orchestrator (paying with the device-auth user token
via ``SignerTokenProvider``) and returns a publish endpoint. There is no
request/response "result" to fetch — the *publish URL* is the deliverable, and a
media client streams frames into it. We keep each live session in an in-process
registry so status/stop tools can act on it.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from . import auth, config


@dataclass
class JobRecord:
    job_id: str
    model_id: str
    client: Any  # LivepeerClient
    job: Any  # LiveVideoToVideo
    created_at: float = field(default_factory=time.time)
    status: str = "connected"


_jobs: dict[str, JobRecord] = {}


def _job_view(rec: JobRecord) -> dict[str, Any]:
    job = rec.job
    return {
        "job_id": rec.job_id,
        "model_id": rec.model_id,
        "status": rec.status,
        "publish_url": getattr(job, "publish_url", None),
        "manifest_id": getattr(job, "manifest_id", None),
        "signer_url": getattr(job, "signer_url", None),
        "created_at": rec.created_at,
    }


async def start_job(
    model_id: str | None = None,
    initial_parameters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Connect a live job and return its handle + publish endpoint."""
    cfg = config.get()
    model = model_id or cfg.default_model_id
    if not model:
        raise ValueError(
            "model_id is required (or set LIVEPEER_MODEL_ID). Use "
            "discover_by_capability to pick a pipeline/model."
        )
    if not cfg.discovery_url:
        raise ValueError(
            "LIVEPEER_DISCOVERY_URL is not set; it is required to route jobs."
        )

    # Fail fast with a clean auth error before touching the network.
    auth.require_token()

    from livepeer_gateway.lv2v import StartJobRequest
    from livepeer_gateway_client import LivepeerClient, SignerTokenProvider

    provider = SignerTokenProvider(
        oidc_base_url=cfg.oidc_base_url,
        client_id=cfg.client_id,
    )
    client = LivepeerClient(
        model_id=model,
        signer_provider=provider,
        discovery_url=cfg.discovery_url,
    )
    job = await client.connect(
        StartJobRequest(model_id=model),
        initial_parameters=initial_parameters or {},
    )

    job_id = uuid.uuid4().hex[:12]
    rec = JobRecord(job_id=job_id, model_id=model, client=client, job=job)
    _jobs[job_id] = rec
    view = _job_view(rec)
    view["message"] = (
        "Live job connected. Stream media into `publish_url` with your media "
        "client; call stop_job when finished."
    )
    return view


def get_job_status(job_id: str) -> dict[str, Any]:
    rec = _jobs.get(job_id)
    if rec is None:
        raise KeyError(f"Unknown job_id: {job_id}")
    return _job_view(rec)


def get_job_result(job_id: str) -> dict[str, Any]:
    """For a live job the 'result' is the streaming publish endpoint."""
    rec = _jobs.get(job_id)
    if rec is None:
        raise KeyError(f"Unknown job_id: {job_id}")
    view = _job_view(rec)
    view["note"] = (
        "This is a live lv2v session. The output is the live stream produced "
        "from frames you publish to publish_url; there is no static result file."
    )
    return view


async def stop_job(job_id: str) -> dict[str, Any]:
    rec = _jobs.get(job_id)
    if rec is None:
        raise KeyError(f"Unknown job_id: {job_id}")
    try:
        await rec.client.disconnect()
    finally:
        rec.status = "stopped"
        _jobs.pop(job_id, None)
    return {"job_id": job_id, "status": "stopped"}


def list_jobs() -> dict[str, Any]:
    return {"jobs": [_job_view(r) for r in _jobs.values()], "count": len(_jobs)}
