import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { isOpenApiContractOperation } from "@/lib/openapi/tags";

export const API_V1_ROOT = join(process.cwd(), "src/app/api/v1");

/**
 * Prefixes excluded from OpenAPI contracts.
 * Legacy `/admin`, `/signer`, `/me`, `/dashboard` stay excluded — Internal docs
 * use `/api/v1/internal/…` (rewrites + virtual metadata).
 */
export const OPENAPI_EXCLUDED_PREFIXES = [
  "oidc/",
  "admin/",
  "webhooks/",
  "oidc/interaction/",
  "me/",
  "dashboard/",
  "signer/",
] as const;

/** Meta routes that serve docs/spec only — not API operations. */
export const OPENAPI_EXCLUDED_FILES = new Set([
  "openapi.json/route.ts",
  "docs/route.ts",
  "internal/openapi.json/route.ts",
  "internal/docs/route.ts",
  // Legacy billing path — Internal documents `/api/v1/internal/billing`
  "billing/route.ts",
  // Legacy usage — Builder documents `/builder/…/usage*`
  "apps/[id]/usage/route.ts",
  "apps/[id]/usage/balance/route.ts",
]);

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
export type HttpMethodLower = Lowercase<HttpMethod>;
const EXPORTED_CONST_METHOD_REGEX = String.raw`export\s+const\s+%METHOD%\s*=`;
const RE_EXPORT_REGEX = /export\s*\{([^}]+)\}/;

export type ScannedRouteOperation = {
  method: HttpMethodLower;
  path: string;
  sourceFile: string;
  excluded: boolean;
  excludedReason?: string;
};

/** Compact constructor for generated route inventory entries (Sonar duplication). */
export function inventoryOp(
  method: HttpMethodLower,
  path: string,
  sourceFile: string,
  excluded = false,
  excludedReason?: string,
): ScannedRouteOperation {
  if (excludedReason) {
    return { method, path, sourceFile, excluded: true, excludedReason };
  }
  return { method, path, sourceFile, excluded };
}

export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export function shouldExcludeOpenApiRoute(relPath: string): string | null {
  if (OPENAPI_EXCLUDED_FILES.has(relPath)) {
    return "excluded from OpenAPI contracts (docs/meta or legacy alias)";
  }
  for (const prefix of OPENAPI_EXCLUDED_PREFIXES) {
    if (relPath.startsWith(prefix)) {
      return `excluded prefix: ${prefix}`;
    }
  }
  return null;
}

export function toOpenApiPath(fileRel: string): string {
  const withoutRoute = fileRel.endsWith("/route.ts")
    ? fileRel.slice(0, -"/route.ts".length)
    : fileRel;
  const segments = withoutRoute.split("/").map((segment, index, all) => {
    if (segment.startsWith("[") && segment.endsWith("]")) {
      const inner = segment.slice(1, -1);
      const appsIdx = all.findIndex((s) => s === "apps");
      const underApps =
        appsIdx >= 0 && all[appsIdx + 1]?.startsWith("[") && index === appsIdx + 1;
      if (inner === "id" && underApps) {
        return "{clientId}";
      }
      if (inner === "externalUserId") {
        return "{externalUserId}";
      }
      if (inner === "planId") {
        return "{planId}";
      }
      if (inner === "profileId") {
        return "{profileId}";
      }
      return `{${inner}}`;
    }
    return segment;
  });
  return `/api/v1/${segments.join("/")}`;
}

export function collectRouteFiles(dir: string, base = ""): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      files.push(...collectRouteFiles(full, rel));
      continue;
    }
    if (entry === "route.ts") {
      files.push(rel);
    }
  }
  return files;
}

export function exportedHttpMethods(source: string): HttpMethod[] {
  const methods = new Set<HttpMethod>();
  for (const method of HTTP_METHODS) {
    if (source.includes(`export async function ${method}`)) {
      methods.add(method);
    }
    if (new RegExp(EXPORTED_CONST_METHOD_REGEX.replace("%METHOD%", method)).test(source)) {
      methods.add(method);
    }
  }
  const reExportMatch = RE_EXPORT_REGEX.exec(source);
  if (reExportMatch) {
    for (const method of HTTP_METHODS) {
      if (reExportMatch[1].includes(method)) {
        methods.add(method);
      }
    }
  }
  return [...methods];
}

export function scanApiV1Routes(apiRoot = API_V1_ROOT): ScannedRouteOperation[] {
  const operations: ScannedRouteOperation[] = [];

  for (const fileRel of collectRouteFiles(apiRoot)) {
    const fileExclusion = shouldExcludeOpenApiRoute(fileRel);
    const source = readFileSync(join(apiRoot, fileRel), "utf8");
    const path = toOpenApiPath(fileRel);

    for (const method of exportedHttpMethods(source)) {
      const methodLower = method.toLowerCase() as HttpMethodLower;
      let excluded = fileExclusion !== null;
      let excludedReason = fileExclusion ?? undefined;
      if (!excluded && !isOpenApiContractOperation(methodLower, path)) {
        excluded = true;
        excludedReason = "not in Builder/End-user/Internal contract";
      }
      operations.push({
        method: methodLower,
        path,
        sourceFile: fileRel,
        excluded,
        excludedReason,
      });
    }
  }

  return operations.toSorted((left, right) =>
    routeKey(left.method, left.path).localeCompare(routeKey(right.method, right.path)),
  );
}

export function publicRouteOperations(
  operations: ScannedRouteOperation[],
): ScannedRouteOperation[] {
  return operations.filter((op) => !op.excluded);
}
