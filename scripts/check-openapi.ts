#!/usr/bin/env npx tsx
/**
 * Drift guard: public route handlers must have OpenAPI metadata;
 * metadata must not reference removed handlers (except virtual routes).
 */
import {
  OPENAPI_PUBLIC_ROUTE_KEYS,
} from "../src/lib/openapi/generated-route-inventory";
import {
  registeredMetadataKeys,
  virtualMetadataEntries,
} from "../src/lib/openapi/route-metadata";
import { routeKey } from "../src/lib/openapi/route-scan";

import "../src/lib/openapi/routes/index";

function printKeyList(header: string, keys: string[]): void {
  if (keys.length === 0) {
    return;
  }
  console.error(header);
  for (const key of keys.toSorted((a, b) => a.localeCompare(b))) {
    console.error(`  - ${key}`);
  }
}

function buildVirtualRouteKeySet(): Set<string> {
  return new Set(
    virtualMetadataEntries().map((entry) => routeKey(entry.method, entry.path)),
  );
}

function getMissingMetadata(publicKeys: readonly string[], metadataKeys: ReadonlySet<string>): string[] {
  return publicKeys.filter((key) => !metadataKeys.has(key));
}

function getStaleMetadata(
  metadataKeys: ReadonlySet<string>,
  publicKeys: readonly string[],
  virtualKeys: ReadonlySet<string>,
): string[] {
  const publicKeySet = new Set(publicKeys);
  return [...metadataKeys].filter((key) => !virtualKeys.has(key) && !publicKeySet.has(key));
}

function main() {
  const metadataKeys = registeredMetadataKeys();
  const virtualKeys = buildVirtualRouteKeySet();
  const missing = getMissingMetadata(OPENAPI_PUBLIC_ROUTE_KEYS, metadataKeys);
  const stale = getStaleMetadata(metadataKeys, OPENAPI_PUBLIC_ROUTE_KEYS, virtualKeys);

  if (missing.length === 0 && stale.length === 0) {
    console.log(
      `OpenAPI drift check passed (${OPENAPI_PUBLIC_ROUTE_KEYS.length} public routes, ${metadataKeys.size} metadata entries).`,
    );
    return;
  }

  printKeyList("OpenAPI metadata missing for public routes:\n", missing);
  printKeyList("\nStale OpenAPI metadata (no backing route handler):\n", stale);
  console.error(
    `\nUpdate src/lib/openapi/routes/* metadata and run npm run openapi:generate.`,
  );
  process.exit(1);
}

main();
