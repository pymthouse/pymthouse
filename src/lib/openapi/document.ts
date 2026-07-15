import { OIDC_MOUNT_PATH } from "@/lib/oidc/issuer-urls";
import { generateOpenApiDocument } from "@/lib/openapi/registry";
import {
  BUILDER_INFO_DESCRIPTION,
  BUILDER_TAG_DEFINITIONS,
  BUILDER_TAG_GROUPS,
  INTERNAL_INFO_DESCRIPTION,
  INTERNAL_TAG_DEFINITIONS,
  INTERNAL_TAG_GROUPS,
  classifyOpenApiOperation,
  type OpenApiAudience,
} from "@/lib/openapi/tags";

export type { OpenApiAudience };

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

/** Public docs = Builder (M2M) + End-user. Internal stays unpublished. */
const PUBLIC_AUDIENCES: OpenApiAudience[] = ["builder", "end-user"];

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

type OpenApiDoc = ReturnType<typeof generateOpenApiDocument> & {
  "x-tagGroups"?: Array<{ name: string; tags: string[] }>;
};

type PathItem = NonNullable<OpenApiDoc["paths"]>[string];

function filterOperations(
  paths: OpenApiDoc["paths"],
  audiences: OpenApiAudience[],
): OpenApiDoc["paths"] {
  if (!paths) {
    return paths;
  }
  const allowed = new Set(audiences);
  const next: NonNullable<OpenApiDoc["paths"]> = {};
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const filtered: Record<string, unknown> = { ...item };
    let keep = false;
    for (const method of HTTP_METHODS) {
      if (!(method in filtered)) {
        continue;
      }
      const audience = classifyOpenApiOperation(method, path);
      if (audience && allowed.has(audience)) {
        keep = true;
      } else {
        delete filtered[method];
      }
    }
    const hasMethod = HTTP_METHODS.some((method) => method in filtered);
    if (keep && hasMethod) {
      next[path] = filtered as PathItem;
    }
  }
  return next;
}

function publicSecuritySchemes() {
  return {
    m2mBasic: {
      type: "http" as const,
      scheme: "basic",
      description:
        "Confidential M2M client (`m2m_…` + `pmth_cs_…` secret). RFC 6749 client authentication.",
    },
    bearerUserJwt: {
      type: "http" as const,
      scheme: "bearer",
      bearerFormat: "JWT",
      description: "Short-lived user access token minted by Builder API or OIDC.",
    },
    endUserBearer: {
      type: "http" as const,
      scheme: "bearer",
      description:
        "End-user credential: composite `app_<24hex>_<secret>` API key, bare `pmth_*` app-user key, programmatic user JWT, or signer JWT.",
    },
  };
}

function internalSecuritySchemes() {
  return {
    adminSession: {
      type: "apiKey" as const,
      in: "cookie" as const,
      name: "next-auth.session-token",
      description:
        "NextAuth session cookie for the signed-in PymtHouse user. Secure deployments use the `__Secure-next-auth.session-token` variant.",
    },
  };
}

/** Public OpenAPI — Builder (M2M) + End-user usage. */
export function buildPublicOpenApiDocument(): OpenApiDoc {
  const doc = generateOpenApiDocument() as OpenApiDoc;
  const serverUrl = resolveApiServerUrl();
  const oidcIssuer = `${serverUrl}${OIDC_MOUNT_PATH}`;

  doc.servers = [{ url: serverUrl, description: "PymtHouse API origin" }];
  doc.paths = filterOperations(doc.paths, PUBLIC_AUDIENCES);
  doc.info = {
    ...doc.info,
    title: "PymtHouse API",
    description: BUILDER_INFO_DESCRIPTION,
  };
  doc.tags = BUILDER_TAG_DEFINITIONS;
  doc["x-tagGroups"] = BUILDER_TAG_GROUPS;
  doc.components = doc.components ?? {};
  doc.components.securitySchemes = publicSecuritySchemes();
  doc.externalDocs = {
    description: "OIDC issuer discovery (device flow, client_credentials)",
    url: `${oidcIssuer}/.well-known/openid-configuration`,
  };
  return doc;
}

/** Internal OpenAPI — dashboard / admin / platform ops (unpublished). */
export function buildInternalOpenApiDocument(): OpenApiDoc {
  const doc = generateOpenApiDocument() as OpenApiDoc;
  const serverUrl = resolveApiServerUrl();
  const oidcIssuer = `${serverUrl}${OIDC_MOUNT_PATH}`;

  doc.servers = [{ url: serverUrl, description: "PymtHouse API origin" }];
  doc.paths = filterOperations(doc.paths, ["internal"]);
  doc.info = {
    ...doc.info,
    title: "PymtHouse Internal API",
    description: INTERNAL_INFO_DESCRIPTION,
  };
  doc.tags = INTERNAL_TAG_DEFINITIONS;
  doc["x-tagGroups"] = INTERNAL_TAG_GROUPS;
  doc.components = doc.components ?? {};
  doc.components.securitySchemes = internalSecuritySchemes();
  doc.externalDocs = {
    description: "OIDC issuer discovery (device flow, client_credentials)",
    url: `${oidcIssuer}/.well-known/openid-configuration`,
  };
  return doc;
}

/** Alias for `/api/v1/openapi.json`. */
export function buildOpenApiDocument(): OpenApiDoc {
  return buildPublicOpenApiDocument();
}
