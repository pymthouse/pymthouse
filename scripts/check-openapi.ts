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

function main() {
  const metadataKeys = registeredMetadataKeys();
  const virtualKeys = new Set(
    virtualMetadataEntries().map((entry) => routeKey(entry.method, entry.path)),
  );

  const missing: string[] = [];
  for (const key of OPENAPI_PUBLIC_ROUTE_KEYS) {
    if (!metadataKeys.has(key)) {
      missing.push(key);
    }
  }

  const publicKeySet = new Set(OPENAPI_PUBLIC_ROUTE_KEYS);
  const stale: string[] = [];
  for (const key of metadataKeys) {
    if (virtualKeys.has(key)) {
      continue;
    }
    if (!publicKeySet.has(key)) {
      stale.push(key);
    }
  }

  if (missing.length > 0 || stale.length > 0) {
    if (missing.length > 0) {
      console.error("OpenAPI metadata missing for public routes:\n");
      for (const key of missing.toSorted((a, b) => a.localeCompare(b))) {
        console.error(`  - ${key}`);
      }
    }
    if (stale.length > 0) {
      console.error("\nStale OpenAPI metadata (no backing route handler):\n");
      for (const key of stale.toSorted((a, b) => a.localeCompare(b))) {
        console.error(`  - ${key}`);
      }
    }
    console.error(
      `\nUpdate src/lib/openapi/routes/* metadata and run npm run openapi:generate.`,
    );
    process.exit(1);
  }

  console.log(
    `OpenAPI drift check passed (${OPENAPI_PUBLIC_ROUTE_KEYS.length} public routes, ${metadataKeys.size} metadata entries).`,
  );
}

main();
