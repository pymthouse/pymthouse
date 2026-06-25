import type { RouteConfig } from "@asteasolutions/zod-to-openapi";

import { defineRouteMetadata } from "@/lib/openapi/route-metadata";
import { OAuthErrorSchema } from "@/lib/openapi/schemas/common";
import { z } from "@/lib/openapi/zod";

export const genericJsonObject = z.object({}).passthrough().openapi("GenericJsonObject");

export const jsonSuccess = {
  description: "Success",
  content: { "application/json": { schema: genericJsonObject } },
} as const;

export const builderErrorResponses = {
  400: { description: "Bad request", content: { "application/json": { schema: OAuthErrorSchema } } },
  401: { description: "Unauthorized", content: { "application/json": { schema: OAuthErrorSchema } } },
  403: { description: "Forbidden", content: { "application/json": { schema: OAuthErrorSchema } } },
  404: { description: "Not found", content: { "application/json": { schema: OAuthErrorSchema } } },
} as const;

type HttpMethod = RouteConfig["method"];

export function registerJsonRouteMetadata(input: {
  method: HttpMethod;
  path: string;
  tags: string[];
  summary: string;
  description?: string;
  security?: Array<Record<string, string[]>>;
  status?: 200 | 201 | 204;
  statusDescription?: string;
  withErrors?: boolean;
}) {
  const status = input.status ?? 200;
  const responses: Record<number, { description: string; content?: typeof jsonSuccess.content }> = {
    [status]: {
      description: input.statusDescription ?? (status === 201 ? "Created" : "Success"),
      ...(status === 204 ? {} : { content: jsonSuccess.content }),
    },
  };
  if (input.withErrors) {
    Object.assign(responses, builderErrorResponses);
  }

  defineRouteMetadata(input.method, input.path, {
    tags: input.tags,
    summary: input.summary,
    description: input.description,
    security: input.security,
    responses,
  });
}
