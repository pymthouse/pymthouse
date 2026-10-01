import type { RouteConfig } from "@asteasolutions/zod-to-openapi";

import { apiVersionOfPath, toV1Path } from "@/lib/api-version/v2-surface";
import { routeKey } from "@/lib/openapi/route-scan";

export type RouteMetadataInput = Omit<RouteConfig, "method" | "path"> & {
  /** Documented operation without a filesystem route handler (e.g. OIDC /token). */
  virtual?: boolean;
};

const metadataByKey = new Map<string, RouteMetadataInput>();

export function defineRouteMetadata(
  method: RouteConfig["method"],
  path: string,
  input: RouteMetadataInput,
): void {
  const key = routeKey(method, path);
  if (metadataByKey.has(key)) {
    throw new Error(`Duplicate OpenAPI route metadata: ${key}`);
  }
  metadataByKey.set(key, input);
}

export function getRouteMetadata(
  method: string,
  path: string,
): RouteMetadataInput | undefined {
  return metadataByKey.get(routeKey(method, path));
}

/** Rewrite `/api/v1/…` references in doc text to v2 (the OIDC issuer stays v1). */
function rewriteDocTextForV2(text: string | undefined): string | undefined {
  return text?.replaceAll(/\/api\/v1\/(?!oidc(?:\/|\b))/g, "/api/v2/");
}

/**
 * Metadata for an operation. v2 aliases and guarded wrappers without their own
 * entry reuse the v1 entry, with path references in summary/description moved
 * onto `/api/v2`.
 */
export function resolveRouteMetadata(
  method: string,
  path: string,
): RouteMetadataInput | undefined {
  const own = getRouteMetadata(method, path);
  if (own || apiVersionOfPath(path) !== "v2") {
    return own;
  }
  const v1 = getRouteMetadata(method, toV1Path(path));
  if (!v1) {
    return undefined;
  }
  return {
    ...v1,
    summary: rewriteDocTextForV2(v1.summary),
    description: rewriteDocTextForV2(v1.description),
  };
}

export function registeredMetadataKeys(): ReadonlySet<string> {
  return new Set(metadataByKey.keys());
}

export function virtualMetadataEntries(): Array<{
  method: RouteConfig["method"];
  path: string;
  meta: RouteMetadataInput;
}> {
  const entries: Array<{
    method: RouteConfig["method"];
    path: string;
    meta: RouteMetadataInput;
  }> = [];
  for (const [key, meta] of metadataByKey) {
    if (!meta.virtual) {
      continue;
    }
    const space = key.indexOf(" ");
    entries.push({
      method: key.slice(0, space).toLowerCase() as RouteConfig["method"],
      path: key.slice(space + 1),
      meta,
    });
  }
  return entries;
}
