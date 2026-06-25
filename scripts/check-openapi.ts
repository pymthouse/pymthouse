#!/usr/bin/env npx tsx
/**
 * Fail CI when a public Builder API route handler is not registered in OpenAPI.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { registeredRouteKeysForCompleteness, routeKey } from "../src/lib/openapi/registry";
import "../src/lib/openapi/routes/index";

const API_ROOT = join(process.cwd(), "src/app/api/v1");

const EXCLUDED_PREFIXES = [
  "oidc/",
  "internal/",
  "admin/",
  "webhooks/",
  "oidc/interaction/",
];

const EXCLUDED_FILES = new Set([
  "openapi.json/route.ts",
  "docs/route.ts",
]);

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function shouldExclude(relPath: string): boolean {
  if (EXCLUDED_FILES.has(relPath)) {
    return true;
  }
  return EXCLUDED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function toOpenApiPath(fileRel: string): string {
  const withoutRoute = fileRel.endsWith("/route.ts")
    ? fileRel.slice(0, -"/route.ts".length)
    : fileRel;
  const segments = withoutRoute.split("/").map((segment, index, all) => {
    if (segment.startsWith("[") && segment.endsWith("]")) {
      const inner = segment.slice(1, -1);
      const underApps = all[0] === "apps" && all[1]?.startsWith("[");
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

function collectRouteFiles(dir: string, base = ""): string[] {
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

function exportedMethods(source: string): string[] {
  const methods: string[] = [];
  for (const method of HTTP_METHODS) {
    if (source.includes(`export async function ${method}`)) {
      methods.push(method);
    }
  }
  return methods;
}

function main() {
  const registered = registeredRouteKeysForCompleteness();
  const missing: string[] = [];

  for (const fileRel of collectRouteFiles(API_ROOT)) {
    if (shouldExclude(fileRel)) {
      continue;
    }
    const source = readFileSync(join(API_ROOT, fileRel), "utf8");
    const path = toOpenApiPath(fileRel);
    for (const method of exportedMethods(source)) {
      const key = routeKey(method, path);
      if (!registered.has(key)) {
        missing.push(key);
      }
    }
  }

  if (missing.length > 0) {
    console.error("OpenAPI registry missing routes:\n");
    const sortedMissing = missing.toSorted((left, right) => left.localeCompare(right));
    for (const key of sortedMissing) {
      console.error(`  - ${key}`);
    }
    console.error(
      `\nRegister them under src/lib/openapi/routes/ (found ${missing.length} missing).`,
    );
    process.exit(1);
  }

  console.log(
    `OpenAPI completeness check passed (${registered.size} registered operations).`,
  );
}

main();
