import { defineRoute } from "@/lib/openapi/registry";
import { OPENAPI_ROUTE_INVENTORY } from "@/lib/openapi/generated-route-inventory";
import {
  getRouteMetadata,
  virtualMetadataEntries,
} from "@/lib/openapi/route-metadata";
import { genericJsonObject, jsonSuccess } from "@/lib/openapi/routes/shared";

let registered = false;

function defaultTagFor(path: string): string {
  if (path.includes("/auth/")) return "Credentials";
  if (path.includes("/usage")) return "Usage";
  if (path.includes("/billing") || path.includes("/plans")) return "Billing";
  if (path.includes("/users")) return "Users";
  if (path.includes("/apps")) return "Apps";
  return "Platform";
}

/**
 * Registers OpenAPI operations from the generated route inventory plus metadata map.
 */
export function registerOpenApiFromInventory(): void {
  if (registered) {
    return;
  }
  registered = true;

  for (const op of OPENAPI_ROUTE_INVENTORY) {
    if (op.excluded) {
      continue;
    }

    const meta = getRouteMetadata(op.method, op.path);
    if (meta) {
      const { virtual: _virtual, ...routeMeta } = meta;
      defineRoute({
        method: op.method,
        path: op.path,
        ...routeMeta,
      });
      continue;
    }

    defineRoute({
      method: op.method,
      path: op.path,
      tags: [defaultTagFor(op.path)],
      summary: op.path,
      responses: {
        200: {
          description: "Success",
          content: { "application/json": { schema: genericJsonObject } },
        },
      },
    });
  }

  for (const { method, path, meta } of virtualMetadataEntries()) {
    const { virtual: _virtual, ...routeMeta } = meta;
    defineRoute({
      method,
      path,
      skipCompletenessCheck: true,
      ...routeMeta,
    });
  }
}
