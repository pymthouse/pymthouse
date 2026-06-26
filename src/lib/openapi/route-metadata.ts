import type { RouteConfig } from "@asteasolutions/zod-to-openapi";

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
