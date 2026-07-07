import { OIDC_MOUNT_PATH } from "@/lib/oidc/issuer-urls";
import { generateOpenApiDocument } from "@/lib/openapi/registry";
import { trimTrailingSlashes } from "@/lib/openapi/string-utils";

function resolveApiServerUrl(): string {
  const issuer = process.env.PYMTHOUSE_ISSUER_URL?.trim();
  if (issuer) {
    try {
      const url = new URL(issuer);
      if (url.pathname.endsWith(OIDC_MOUNT_PATH)) {
        url.pathname = url.pathname.slice(0, -OIDC_MOUNT_PATH.length) || "/";
      }
      return url.origin;
    } catch {
      /* fall through */
    }
  }
  const base = process.env.PYMTHOUSE_BASE_URL?.trim();
  if (base) {
    try {
      return new URL(base).origin;
    } catch {
      /* fall through */
    }
  }
  return "http://localhost:3001";
}

function resolveOidcIssuerUrl(): string {
  const issuer = process.env.PYMTHOUSE_ISSUER_URL?.trim();
  if (issuer) {
    return trimTrailingSlashes(issuer);
  }
  return `${resolveApiServerUrl()}${OIDC_MOUNT_PATH}`;
}

export function buildOpenApiDocument() {
  const doc = generateOpenApiDocument();
  const serverUrl = resolveApiServerUrl();
  const oidcIssuer = resolveOidcIssuerUrl();

  doc.servers = [{ url: serverUrl, description: "PymtHouse API origin" }];

  doc.components = doc.components ?? {};
  doc.components.securitySchemes = {
  ...doc.components.securitySchemes,
    m2mBasic: {
      type: "http",
      scheme: "basic",
      description:
        "Confidential M2M client (`m2m_…` + `pmth_cs_…` secret). RFC 6749 client authentication.",
    },
    bearerUserJwt: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
      description: "Short-lived user access token minted by Builder API or OIDC.",
    },
    adminSession: {
      type: "http",
      scheme: "bearer",
      description: "Dashboard admin session or admin-scoped platform token.",
    },
  };

  doc.externalDocs = {
    description: "OIDC issuer discovery (device flow, client_credentials)",
    url: `${oidcIssuer}/.well-known/openid-configuration`,
  };

  return doc;
}
