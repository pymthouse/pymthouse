#!/usr/bin/env python3
"""Fetch JWKS from URL and write the first RSA public key as PEM (for mod_authnz_jwt)."""
from __future__ import annotations

import argparse
import base64
import binascii
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

_DEV_HTTP_HOSTS = frozenset(
    {
        "localhost",
        "127.0.0.1",
        "::1",
        "host.docker.internal",
    }
)

_ALLOWED_OUT_ROOTS = (
    Path("/data"),
    Path("/etc"),
    Path.cwd(),
)


def _b64url_decode(s: str) -> bytes:
    pad = 4 - len(s) % 4
    if pad != 4:
        s += "=" * pad
    return base64.urlsafe_b64decode(s.encode("ascii"))


def _decode_jwk_param(jwk: dict, name: str) -> int:
    # Wrap each base64url field decode so a corrupt "n" or "e" produces a
    # descriptive error instead of a bare "Invalid base64-encoded string".
    # binascii.Error is a ValueError subclass so callers can keep catching ValueError,
    # but keeping this explicit preserves the JWK field name in the message.
    raw = jwk[name]
    if not isinstance(raw, str):
        raise ValueError(f"invalid JWK field {name!r}: expected string")
    try:
        return int.from_bytes(_b64url_decode(raw), "big")
    except (binascii.Error, ValueError) as err:
        raise ValueError(f"invalid base64url in JWK field {name!r}: {err}") from err


def _jwks_url_allowed(parsed: urllib.parse.ParseResult) -> bool:
    if not parsed.netloc:
        return False
    host = (parsed.hostname or "").lower()
    if parsed.scheme == "https":
        return True
    return parsed.scheme == "http" and host in _DEV_HTTP_HOSTS


class _RejectDisallowedJwksRedirects(urllib.request.HTTPRedirectHandler):
    """Refuse redirects to schemes/hosts that would bypass initial URL validation."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        merged = urllib.parse.urljoin(req.full_url, newurl)
        parsed = urllib.parse.urlparse(merged)
        if not _jwks_url_allowed(parsed):
            raise urllib.error.HTTPError(
                merged,
                code,
                f"jwks_to_pem: redirect to disallowed URL: {merged!r}",
                headers,
                fp,
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def jwk_rsa_to_pem(jwk: dict) -> bytes:
    if jwk.get("kty") != "RSA":
        raise ValueError(f"Unsupported kty: {jwk.get('kty')}")
    n = _decode_jwk_param(jwk, "n")
    e = _decode_jwk_param(jwk, "e")
    pub = rsa.RSAPublicNumbers(e, n).public_key(default_backend())
    return pub.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )


def _validated_out_path(out: Path) -> Path:
    """Resolve --out and reject paths that escape allowed roots (Sonar S8707)."""
    expanded = out.expanduser()
    resolved = (
        expanded.resolve()
        if expanded.is_absolute()
        else (Path.cwd() / expanded).resolve()
    )
    allowed_roots = [root.expanduser().resolve() for root in _ALLOWED_OUT_ROOTS]
    for root in allowed_roots:
        try:
            resolved.relative_to(root)
            return resolved
        except ValueError:
            continue
    raise ValueError(
        f"output path {resolved} is outside allowed roots "
        f"({', '.join(str(r) for r in allowed_roots)})"
    )


def _build_opener(parsed: urllib.parse.ParseResult) -> urllib.request.OpenerDirector:
    redirect_handler = _RejectDisallowedJwksRedirects()
    if parsed.scheme == "https":
        # Always verify certificates and hostnames (no CERT_NONE / check_hostname=False).
        # Local/dev JWKS should use http://localhost or http://host.docker.internal.
        ctx = ssl.create_default_context()
        return urllib.request.build_opener(
            redirect_handler,
            urllib.request.HTTPHandler(),
            urllib.request.HTTPSHandler(context=ctx),
        )
    return urllib.request.build_opener(
        redirect_handler,
        urllib.request.HTTPHandler(),
    )


def _fetch_jwks_body(url: str) -> bytes | None:
    parsed = urllib.parse.urlparse(url)
    if not parsed.netloc:
        print(f"jwks_to_pem: invalid JWKS URL (no host): {url!r}", file=sys.stderr)
        return None
    if not _jwks_url_allowed(parsed):
        print(
            "jwks_to_pem: JWKS URL must be https, or http on "
            f"localhost/127.0.0.1/host.docker.internal: {url!r}",
            file=sys.stderr,
        )
        return None

    req = urllib.request.Request(url, headers={"User-Agent": "pymthouse-signer-dmz/1.0"})
    try:
        opener = _build_opener(parsed)
        with opener.open(req, timeout=30) as resp:
            final = urllib.parse.urlparse(resp.geturl())
            if not _jwks_url_allowed(final):
                print(
                    f"jwks_to_pem: final URL after redirects is not allowed: {resp.geturl()!r}",
                    file=sys.stderr,
                )
                return None
            return resp.read()
    except urllib.error.URLError as e:
        print(f"jwks_to_pem: fetch failed: {e}", file=sys.stderr)
        return None


def _parse_jwks_doc(body: bytes) -> dict | None:
    try:
        doc = json.loads(body.decode("utf-8"))
    except UnicodeDecodeError as e:
        print(f"jwks_to_pem: JWKS body is not valid UTF-8: {e}", file=sys.stderr)
        return None
    except json.JSONDecodeError as e:
        print(f"jwks_to_pem: invalid JSON: {e}", file=sys.stderr)
        return None

    if not isinstance(doc, dict):
        print(
            f"jwks_to_pem: JWKS JSON must be an object, got {type(doc).__name__}",
            file=sys.stderr,
        )
        return None
    return doc


def _choose_rsa_key(keys: list, kid: str | None) -> dict | None:
    if kid:
        for k in keys:
            if isinstance(k, dict) and k.get("kid") == kid and k.get("kty") == "RSA":
                return k
        print(f"jwks_to_pem: no RSA key with kid={kid!r}", file=sys.stderr)
        return None

    for k in keys:
        if isinstance(k, dict) and k.get("kty") == "RSA":
            return k
    print("jwks_to_pem: no RSA key in JWKS", file=sys.stderr)
    return None


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--url",
        default="https://pymthouse.com/api/v1/oidc/jwks",
        help="JWKS URL",
    )
    p.add_argument(
        "--out",
        required=True,
        type=Path,
        help="Output PEM path",
    )
    p.add_argument(
        "--kid",
        default=None,
        help="If set, pick the RSA key with this kid (else first RSA key)",
    )
    args = p.parse_args()

    if os.environ.get("JWKS_TLS_INSECURE", "").strip():
        print(
            "jwks_to_pem: JWKS_TLS_INSECURE is no longer supported; "
            "use http://localhost or http://host.docker.internal for local JWKS",
            file=sys.stderr,
        )

    body = _fetch_jwks_body(args.url)
    if body is None:
        return 1

    doc = _parse_jwks_doc(body)
    if doc is None:
        return 1

    keys = doc.get("keys")
    if not isinstance(keys, list) or not keys:
        print("jwks_to_pem: no keys in JWKS", file=sys.stderr)
        return 1

    chosen = _choose_rsa_key(keys, args.kid)
    if chosen is None:
        return 1

    try:
        pem = jwk_rsa_to_pem(chosen)
        out_path = _validated_out_path(args.out)
    except ValueError as e:
        print(f"jwks_to_pem: {e}", file=sys.stderr)
        return 1

    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(pem)
    except OSError as e:
        print(
            f"jwks_to_pem: cannot write PEM to {out_path}: {e}",
            file=sys.stderr,
        )
        return 1

    kid = chosen.get("kid", "?")
    print(f"jwks_to_pem: wrote {out_path} (kid={kid})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
