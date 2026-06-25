import { defineRoute } from "@/lib/openapi/registry";
import { OAuthErrorSchema } from "@/lib/openapi/schemas/common";
import { z } from "@/lib/openapi/zod";

const jsonObject = z.object({}).passthrough();

defineRoute({
  method: "get",
  path: "/api/v1/signer",
  tags: ["Signer"],
  summary: "Signer configuration",
  security: [{ adminSession: [] }],
  responses: {
    200: { description: "Signer config", content: { "application/json": { schema: jsonObject } } },
  },
});

defineRoute({
  method: "patch",
  path: "/api/v1/signer",
  tags: ["Signer"],
  summary: "Update signer configuration",
  security: [{ adminSession: [] }],
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: jsonObject } } },
  },
});

defineRoute({
  method: "get",
  path: "/api/v1/signer/cli-status",
  tags: ["Signer"],
  summary: "Signer CLI status",
  responses: {
    200: { description: "CLI status", content: { "application/json": { schema: jsonObject } } },
  },
});

defineRoute({
  method: "get",
  path: "/api/v1/signer/logs",
  tags: ["Signer"],
  summary: "Signer logs",
  security: [{ adminSession: [] }],
  responses: {
    200: { description: "Log tail", content: { "application/json": { schema: jsonObject } } },
  },
});

defineRoute({
  method: "post",
  path: "/api/v1/signer/control",
  tags: ["Signer"],
  summary: "Signer control actions",
  security: [{ adminSession: [] }],
  responses: {
    200: { description: "Control result", content: { "application/json": { schema: jsonObject } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: OAuthErrorSchema } } },
  },
});

defineRoute({
  method: "get",
  path: "/api/v1/billing",
  tags: ["Billing"],
  summary: "Platform billing overview",
  security: [{ adminSession: [] }],
  responses: {
    200: { description: "Billing overview", content: { "application/json": { schema: jsonObject } } },
  },
});

defineRoute({
  method: "get",
  path: "/api/v1/end-users",
  tags: ["Users"],
  summary: "List end users",
  security: [{ adminSession: [] }],
  responses: {
    200: { description: "End users", content: { "application/json": { schema: jsonObject } } },
  },
});

defineRoute({
  method: "post",
  path: "/api/v1/end-users",
  tags: ["Users"],
  summary: "Create end user",
  security: [{ adminSession: [] }],
  responses: {
    201: { description: "Created", content: { "application/json": { schema: jsonObject } } },
  },
});

defineRoute({
  method: "get",
  path: "/api/v1/subscriptions",
  tags: ["Billing"],
  summary: "List subscriptions",
  security: [{ adminSession: [] }],
  responses: {
    200: { description: "Subscriptions", content: { "application/json": { schema: jsonObject } } },
  },
});

defineRoute({
  method: "post",
  path: "/api/v1/subscriptions",
  tags: ["Billing"],
  summary: "Create subscription",
  security: [{ adminSession: [] }],
  responses: {
    201: { description: "Created", content: { "application/json": { schema: jsonObject } } },
  },
});

defineRoute({
  method: "delete",
  path: "/api/v1/subscriptions",
  tags: ["Billing"],
  summary: "Cancel subscription",
  security: [{ adminSession: [] }],
  responses: {
    200: { description: "Cancelled" },
  },
});

defineRoute({
  method: "get",
  path: "/api/v1/prices/eth-usd",
  tags: ["Platform"],
  summary: "ETH/USD spot price",
  responses: {
    200: { description: "Price snapshot", content: { "application/json": { schema: jsonObject } } },
  },
});
