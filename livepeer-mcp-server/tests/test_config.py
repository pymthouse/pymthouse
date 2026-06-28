import importlib

from livepeer_mcp import config


def test_defaults(monkeypatch):
    for var in [
        "PYMTHOUSE_BASE_URL",
        "LIVEPEER_OIDC_BASE_URL",
        "PYMTHOUSE_API_BASE_URL",
        "LIVEPEER_CLIENT_ID",
        "LIVEPEER_SCOPES",
        "LIVEPEER_DISCOVERY_URL",
        "LIVEPEER_MODEL_ID",
    ]:
        monkeypatch.delenv(var, raising=False)

    cfg = config.get()
    assert cfg.pymthouse_base_url == "https://staging.pymthouse.com"
    assert cfg.oidc_base_url == "https://staging.pymthouse.com/api/v1/oidc"
    assert cfg.api_base_url == "https://staging.pymthouse.com/api/v1"
    assert cfg.client_id == "livepeer-sdk"
    assert cfg.scopes == "openid profile gateway"
    assert cfg.discovery_url is None
    assert cfg.default_model_id is None


def test_base_url_derives_issuer_and_api(monkeypatch):
    monkeypatch.setenv("PYMTHOUSE_BASE_URL", "https://app.example.com/")
    monkeypatch.delenv("LIVEPEER_OIDC_BASE_URL", raising=False)
    monkeypatch.delenv("PYMTHOUSE_API_BASE_URL", raising=False)

    cfg = config.get()
    assert cfg.oidc_base_url == "https://app.example.com/api/v1/oidc"
    assert cfg.api_base_url == "https://app.example.com/api/v1"


def test_explicit_overrides(monkeypatch):
    monkeypatch.setenv("PYMTHOUSE_BASE_URL", "https://app.example.com")
    monkeypatch.setenv("LIVEPEER_OIDC_BASE_URL", "https://id.example.com/oidc/")
    monkeypatch.setenv("PYMTHOUSE_API_BASE_URL", "https://api.example.com/v9/")
    monkeypatch.setenv("LIVEPEER_DISCOVERY_URL", "https://disc.example.com/raw")
    monkeypatch.setenv("LIVEPEER_MODEL_ID", "streamdiffusion-sdxl")

    cfg = config.get()
    assert cfg.oidc_base_url == "https://id.example.com/oidc"
    assert cfg.api_base_url == "https://api.example.com/v9"
    assert cfg.discovery_url == "https://disc.example.com/raw"
    assert cfg.default_model_id == "streamdiffusion-sdxl"
