/**
 * Side-effect imports register OpenAPI metadata keyed by route inventory.
 * `registerOpenApiFromInventory()` binds metadata to scanned route handlers.
 */
import "@/lib/openapi/routes/credentials";
import "@/lib/openapi/routes/apps";
import "@/lib/openapi/routes/misc";
import "@/lib/openapi/routes/platform";
import { registerOpenApiFromInventory } from "@/lib/openapi/register-from-inventory";

registerOpenApiFromInventory();
