import {
  API_V2_PREFIX,
  apiVersionOfPath,
  type ApiVersion,
  V2_EXCLUDED_V1_OPERATIONS,
} from "@/lib/api-version/v2-surface";
import { OIDC_MOUNT_PATH } from "@/lib/oidc/issuer-urls";
import { generateOpenApiDocument } from "@/lib/openapi/registry";
import {
  BUILDER_TAG_GROUPS,
  builderInfoDescription,
  builderTagDefinitions,
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

function filterPathItem(
  path: string,
  item: PathItem,
  allowed: Set<OpenApiAudience>,
): PathItem | null {
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
  return keep ? (filtered as PathItem) : null;
}

function filterOperations(
  paths: OpenApiDoc["paths"],
  audiences: OpenApiAudience[],
  version?: ApiVersion,
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
    if (version && apiVersionOfPath(path) !== version) {
      continue;
    }
    const filtered = filterPathItem(path, item, allowed);
    if (filtered) {
      next[path] = filtered;
    }
  }
  return next;
}

type Operation = {
  deprecated?: boolean;
  description?: string;
  tags?: string[];
};

/** v1 doc: flag legacy ops that v2 dropped, pointing at the successor. */
function markV1LegacyOperations(paths: OpenApiDoc["paths"]): void {
  if (!paths) {
    return;
  }
  for (const [key, excluded] of V2_EXCLUDED_V1_OPERATIONS) {
    if (!excluded.meBillingSuccessor) {
      continue;
    }
    const space = key.indexOf(" ");
    const method = key.slice(0, space).toLowerCase();
    const path = key.slice(space + 1);
    const op = (paths[path] as Record<string, Operation> | undefined)?.[method];
    if (!op) {
      continue;
    }
    op.deprecated = true;
    const successor = `${API_V2_PREFIX}/apps/{clientId}/me/billing${excluded.meBillingSuccessor}`;
    op.description = [
      `**Deprecated.** ${excluded.reason} Use \`${successor}\` with the end user's Bearer credential.`,
      op.description,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
}

/** Drop tag definitions with no operations left after filtering. */
function usedTags<T extends { name: string }>(
  paths: OpenApiDoc["paths"],
  definitions: T[],
): T[] {
  const used = new Set<string>();
  for (const item of Object.values(paths ?? {})) {
    for (const op of Object.values((item ?? {}) as Record<string, Operation>)) {
      for (const tag of op?.tags ?? []) {
        used.add(tag);
      }
    }
  }
  return definitions.filter((definition) => used.has(definition.name));
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
        "End-user credential: bare `pmth_*` app-user key, programmatic user JWT, or signer JWT (optional composite `app_<24hex>_<secret>`).",
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

/** Public OpenAPI — Builder (M2M) + End-user for one API version (default v2). */
export function buildPublicOpenApiDocument(
  options: { version?: ApiVersion } = {},
): OpenApiDoc {
  const version = options.version ?? "v2";
  const doc = generateOpenApiDocument() as OpenApiDoc;
  const serverUrl = resolveApiServerUrl();
  const oidcIssuer = `${serverUrl}${OIDC_MOUNT_PATH}`;

  doc.servers = [{ url: serverUrl, description: "PymtHouse API origin" }];
  doc.paths = filterOperations(doc.paths, PUBLIC_AUDIENCES, version);
  if (version === "v1") {
    markV1LegacyOperations(doc.paths);
  }
  doc.info = {
    ...doc.info,
    title:
      version === "v2" ? "PymtHouse Builder API" : "PymtHouse Builder API (v1, legacy)",
    version: version === "v2" ? "2.0.0" : "1.0.0",
    description: builderInfoDescription(version),
  };
  const tags = usedTags(doc.paths, builderTagDefinitions(version));
  const tagNames = new Set(tags.map((tag) => tag.name));
  doc.tags = tags;
  doc["x-tagGroups"] = BUILDER_TAG_GROUPS.map((group) => ({
    ...group,
    tags: group.tags.filter((tag) => tagNames.has(tag)),
  })).filter((group) => group.tags.length > 0);
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

/** Current public document (`/api/v2/openapi.json`). */
export function buildOpenApiDocument(): OpenApiDoc {
  return buildPublicOpenApiDocument({ version: "v2" });
}
