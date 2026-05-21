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


def _jwks_dev_tls_hosts() -> frozenset[str]:
    """Hostnames where we skip TLS verification when JWKS is served over HTTPS with a dev cert."""
    return frozenset(
        {
            "localhost",
            "127.0.0.1",
            "::1",
            "host.docker.internal",
        }
    )


def _jwks_tls_verify_disabled(parsed: urllib.parse.ParseResult) -> bool:
    """True to disable certificate verification (local HTTPS / corporate MITM / self-signed)."""
    if parsed.scheme != "https":
        return False
    flag = os.environ.get("JWKS_TLS_INSECURE", "").strip().lower()
    if flag in ("1", "true", "yes", "on"):
        return True
    host = (parsed.hostname or "").lower()
    return host in _jwks_dev_tls_hosts()


def _https_client_context(parsed: urllib.parse.ParseResult) -> ssl.SSLContext:
    if _jwks_tls_verify_disabled(parsed):
        reason = (
            "JWKS_TLS_INSECURE"
            if os.environ.get("JWKS_TLS_INSECURE", "").strip().lower()
            in ("1", "true", "yes", "on")
            else f"dev hostname {parsed.hostname!r}"
        )
        print(
            f"jwks_to_pem: WARNING: TLS certificate verification disabled ({reason}); "
            "use only in local development",
            file=sys.stderr,
        )
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    return ssl.create_default_context()


def _jwks_url_allowed(parsed: urllib.parse.ParseResult) -> bool:
    if not parsed.netloc:
        return False
    host = (parsed.hostname or "").lower()
    allow_http_dev = parsed.scheme == "http" and host in (
        "localhost",
        "127.0.0.1",
        "::1",
        "host.docker.internal",
    )
    if parsed.scheme == "https":
        return True
    if allow_http_dev:
        return True
    return False


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

    parsed = urllib.parse.urlparse(args.url)
    if not parsed.netloc:
        print(f"jwks_to_pem: invalid JWKS URL (no host): {args.url!r}", file=sys.stderr)
        return 1

    if not _jwks_url_allowed(parsed):
        print(
            f"jwks_to_pem: JWKS URL must be https, or http on localhost/127.0.0.1/host.docker.internal: {args.url!r}",
            file=sys.stderr,
        )
        return 1

    req = urllib.request.Request(args.url, headers={"User-Agent": "pymthouse-signer-dmz/1.0"})
    redirect_handler = _RejectDisallowedJwksRedirects()
    try:
        if parsed.scheme == "https":
            ctx = _https_client_context(parsed)
            opener = urllib.request.build_opener(
                redirect_handler,
                urllib.request.HTTPHandler(),
                urllib.request.HTTPSHandler(context=ctx),
            )
        else:
            opener = urllib.request.build_opener(
                redirect_handler,
                urllib.request.HTTPHandler(),
            )
        with opener.open(req, timeout=30) as resp:
            final = urllib.parse.urlparse(resp.geturl())
            if not _jwks_url_allowed(final):
                print(
                    f"jwks_to_pem: final URL after redirects is not allowed: {resp.geturl()!r}",
                    file=sys.stderr,
                )
                return 1
            body = resp.read()
    except urllib.error.URLError as e:
        print(f"jwks_to_pem: fetch failed: {e}", file=sys.stderr)
        return 1

    try:
        doc = json.loads(body.decode("utf-8"))
    except UnicodeDecodeError as e:
        # UnicodeDecodeError is a ValueError but not a JSONDecodeError, so the
        # previous handler let it crash. Catch it so a non-UTF-8 JWKS payload
        # (e.g. upstream misconfiguration, captive-portal HTML) exits cleanly.
        print(f"jwks_to_pem: JWKS body is not valid UTF-8: {e}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as e:
        print(f"jwks_to_pem: invalid JSON: {e}", file=sys.stderr)
        return 1

    if not isinstance(doc, dict):
        print(
            f"jwks_to_pem: JWKS JSON must be an object, got {type(doc).__name__}",
            file=sys.stderr,
        )
        return 1

    keys = doc.get("keys")
    if not isinstance(keys, list) or not keys:
        print("jwks_to_pem: no keys in JWKS", file=sys.stderr)
        return 1

    chosen: dict | None = None
    if args.kid:
        for k in keys:
            if isinstance(k, dict) and k.get("kid") == args.kid and k.get("kty") == "RSA":
                chosen = k
                break
        if chosen is None:
            print(f"jwks_to_pem: no RSA key with kid={args.kid!r}", file=sys.stderr)
            return 1
    else:
        for k in keys:
            if isinstance(k, dict) and k.get("kty") == "RSA":
                chosen = k
                break
        if chosen is None:
            print("jwks_to_pem: no RSA key in JWKS", file=sys.stderr)
            return 1

    try:
        pem = jwk_rsa_to_pem(chosen)
    except (KeyError, ValueError) as e:
        print(f"jwks_to_pem: {e}", file=sys.stderr)
        return 1

    try:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_bytes(pem)
    except OSError as e:
        print(
            f"jwks_to_pem: cannot write PEM to {args.out}: {e}",
            file=sys.stderr,
        )
        return 1

    kid = chosen.get("kid", "?")
    print(f"jwks_to_pem: wrote {args.out} (kid={kid})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
