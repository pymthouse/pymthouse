import httpx

from livepeer_mcp import pymthouse


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler), base_url="http://test")


def test_list_capabilities_unwraps_catalog(monkeypatch):
    monkeypatch.setenv("PYMTHOUSE_API_BASE_URL", "https://api.example.com/v1")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/pipeline-catalog"
        return httpx.Response(
            200,
            json={
                "catalog": [
                    {"id": "live-video-to-video", "name": "Live V2V", "models": ["a", "b"]},
                ]
            },
        )

    out = pymthouse.list_capabilities(client=_client(handler))
    assert out["count"] == 1
    assert out["capabilities"][0]["id"] == "live-video-to-video"


def test_discover_by_capability_passes_params(monkeypatch):
    monkeypatch.setenv("PYMTHOUSE_API_BASE_URL", "https://api.example.com/v1")
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/pipeline-pricing"
        seen["pipeline"] = request.url.params.get("pipeline")
        seen["model"] = request.url.params.get("model")
        return httpx.Response(
            200,
            json={"pricing": [{"orchAddress": "0xabc", "pipeline": "p", "model": "m"}]},
        )

    out = pymthouse.discover_by_capability("p", "m", client=_client(handler))
    assert seen == {"pipeline": "p", "model": "m"}
    assert out["count"] == 1
    assert out["providers"][0]["orchAddress"] == "0xabc"


def test_discover_omits_model_when_absent(monkeypatch):
    monkeypatch.setenv("PYMTHOUSE_API_BASE_URL", "https://api.example.com/v1")

    def handler(request: httpx.Request) -> httpx.Response:
        assert "model" not in request.url.params
        return httpx.Response(200, json={"pricing": []})

    out = pymthouse.discover_by_capability("p", client=_client(handler))
    assert out["count"] == 0
