import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  type RouteConfig,
} from "@asteasolutions/zod-to-openapi";
import type { ZodTypeAny } from "zod";

export const openApiRegistry = new OpenAPIRegistry();

const registeredRouteKeys = new Set<string>();

export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export type DefineRouteInput = RouteConfig & {
  /** When true, excluded from CI completeness checks (e.g. OIDC passthrough). */
  skipCompletenessCheck?: boolean;
};

export function defineRoute(input: DefineRouteInput): void {
  const key = routeKey(input.method, input.path);
  if (registeredRouteKeys.has(key)) {
    throw new Error(`Duplicate OpenAPI route registration: ${key}`);
  }
  registeredRouteKeys.add(key);
  if (!input.skipCompletenessCheck) {
    completenessRegisteredKeys.add(key);
  }
  openApiRegistry.registerPath(input);
}

export function registerSchema<T extends ZodTypeAny>(
  name: string,
  schema: T,
): T {
  openApiRegistry.register(name, schema);
  return schema;
}

const completenessRegisteredKeys = new Set<string>();

export function registeredRouteKeysForCompleteness(): ReadonlySet<string> {
  return completenessRegisteredKeys;
}

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(openApiRegistry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "PymtHouse Builder API",
      version: "1.0.0",
      description:
        "Machine-facing Builder API for integrator backends. " +
        "Signer session exchange: `POST /api/v1/apps/{clientId}/oidc/token`. " +
        "OIDC provider metadata (device flow, client_credentials) is published via OpenID Provider Configuration.",
    },
  });
}
