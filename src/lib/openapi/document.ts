import { OIDC_MOUNT_PATH } from "@/lib/oidc/issuer-urls";
import { generateOpenApiDocument } from "@/lib/openapi/registry";

function resolveApiServerUrl(): string {
  const configured = process.env.NEXTAUTH_URL?.trim() || "http://localhost:3001";
  try {
    return new URL(configured).origin;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(
      `Invalid NEXTAUTH_URL for OpenAPI server URL (${JSON.stringify(configured)}): ${detail}; falling back to http://localhost:3001`,
    );
    return "http://localhost:3001";
  }
}

export function buildOpenApiDocument() {
  const doc = generateOpenApiDocument();
  const serverUrl = resolveApiServerUrl();
  const oidcIssuer = `${serverUrl}${OIDC_MOUNT_PATH}`;

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
