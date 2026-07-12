import { defineRoute } from "@/lib/openapi/registry";
import { OPENAPI_ROUTE_INVENTORY } from "@/lib/openapi/generated-route-inventory";
import {
  getRouteMetadata,
  virtualMetadataEntries,
} from "@/lib/openapi/route-metadata";
import { isOpenApiContractOperation } from "@/lib/openapi/tags";

let registered = false;

/**
 * Registers OpenAPI operations from the generated route inventory plus metadata map.
 * Only Builder / End-user / Internal contract operations with explicit metadata are registered.
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
    if (!isOpenApiContractOperation(op.method, op.path)) {
      continue;
    }

    const meta = getRouteMetadata(op.method, op.path);
    if (!meta) {
      continue;
    }

    const { virtual: _virtual, ...routeMeta } = meta;
    defineRoute({
      method: op.method,
      path: op.path,
      ...routeMeta,
    });
  }

  for (const { method, path, meta } of virtualMetadataEntries()) {
    if (!isOpenApiContractOperation(method, path)) {
      continue;
    }
    const { virtual: _virtual, ...routeMeta } = meta;
    defineRoute({
      method,
      path,
      skipCompletenessCheck: true,
      ...routeMeta,
    });
  }
}
