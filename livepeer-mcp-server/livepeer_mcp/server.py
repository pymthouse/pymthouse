"""MCP server exposing the Livepeer network over stdio.

Tool surface follows the capability progression:

    login / auth_status / logout   - seamless device-code auth
    list_capabilities              - summary-level capabilities
    discover_by_capability         - concrete providers + pricing
    start_job / get_job_status /
    get_job_result / stop_job      - live (lv2v) jobs

Discovery/auth tools are synchronous; job tools are async (the gateway client
is asyncio-based) and run on FastMCP's event loop.
"""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP

from . import auth, config, jobs, pymthouse

mcp = FastMCP("livepeer")


# --- auth -------------------------------------------------------------------

@mcp.tool()
def login() -> dict[str, Any]:
    """Begin device-code sign-in to the Livepeer network (via PymtHouse).

    Returns a verification URL and user code to approve in a browser. Sign-in
    completes in the background; poll with `auth_status`. Tokens are cached and
    reused across calls, so this is usually only needed once.
    """
    return auth.begin_login()


@mcp.tool()
def auth_status() -> dict[str, Any]:
    """Report whether a valid Livepeer/PymtHouse session is available."""
    return auth.status()


@mcp.tool()
def logout() -> dict[str, Any]:
    """Clear the cached session token."""
    return auth.logout()


# --- discovery --------------------------------------------------------------

@mcp.tool()
def list_capabilities() -> dict[str, Any]:
    """List available Livepeer capabilities (pipelines and their models).

    Summary level and cheap: no auth, no job side effects.
    """
    return pymthouse.list_capabilities()


@mcp.tool()
def discover_by_capability(pipeline: str, model: str | None = None) -> dict[str, Any]:
    """Discover concrete providers and pricing for a capability.

    Args:
        pipeline: Pipeline id from `list_capabilities` (e.g. "live-video-to-video").
        model: Optional model id to narrow results.
    """
    return pymthouse.discover_by_capability(pipeline, model)


# --- jobs -------------------------------------------------------------------

@mcp.tool()
async def start_job(
    model_id: str | None = None,
    initial_parameters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Start a live (lv2v) job against a discovered capability.

    Requires sign-in (`login`) and LIVEPEER_DISCOVERY_URL. Returns a job handle
    and a `publish_url` to stream media into.

    Args:
        model_id: Model to run (defaults to LIVEPEER_MODEL_ID).
        initial_parameters: Optional pipeline-specific parameters.
    """
    return await jobs.start_job(model_id, initial_parameters)


@mcp.tool()
def get_job_status(job_id: str) -> dict[str, Any]:
    """Get the status of a started job."""
    return jobs.get_job_status(job_id)


@mcp.tool()
def get_job_result(job_id: str) -> dict[str, Any]:
    """Get the result endpoint of a started job (the live publish URL)."""
    return jobs.get_job_result(job_id)


@mcp.tool()
async def stop_job(job_id: str) -> dict[str, Any]:
    """Stop a running job and release its session."""
    return await jobs.stop_job(job_id)


@mcp.tool()
def list_jobs() -> dict[str, Any]:
    """List live jobs tracked by this server process."""
    return jobs.list_jobs()


def main() -> None:
    """Console-script entry point: run the server over stdio."""
    # Surface effective config to stderr (never stdout — that's the MCP channel).
    cfg = config.get()
    import sys

    print(
        f"[livepeer-mcp] issuer={cfg.oidc_base_url} api={cfg.api_base_url} "
        f"client_id={cfg.client_id} discovery={'set' if cfg.discovery_url else 'unset'}",
        file=sys.stderr,
    )
    mcp.run()


if __name__ == "__main__":
    main()
