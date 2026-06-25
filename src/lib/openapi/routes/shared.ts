import { defineRoute } from "@/lib/openapi/registry";
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

type HttpMethod = "get" | "post" | "put" | "delete" | "patch";

export function registerJsonRoute(input: {
  method: HttpMethod;
  path: string;
  tags: string[];
  summary: string;
  description?: string;
  deprecated?: boolean;
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

  defineRoute({
    method: input.method,
    path: input.path,
    tags: input.tags,
    summary: input.summary,
    description: input.description,
    deprecated: input.deprecated,
    security: input.security,
    responses,
  });
}
