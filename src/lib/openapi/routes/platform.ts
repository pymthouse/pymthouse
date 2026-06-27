import { registerJsonRouteMetadata } from "@/lib/openapi/routes/shared";

const adminSession = [{ adminSession: [] }];

registerJsonRouteMetadata({
  method: "get",
  path: "/api/v1/signer",
  tags: ["Signer"],
  summary: "Signer configuration",
  security: adminSession,
});

registerJsonRouteMetadata({
  method: "patch",
  path: "/api/v1/signer",
  tags: ["Signer"],
  summary: "Update signer configuration",
  security: adminSession,
  statusDescription: "Updated",
});

registerJsonRouteMetadata({
  method: "get",
  path: "/api/v1/signer/cli-status",
  tags: ["Signer"],
  summary: "Signer CLI status",
  statusDescription: "CLI status",
});

registerJsonRouteMetadata({
  method: "get",
  path: "/api/v1/signer/logs",
  tags: ["Signer"],
  summary: "Signer logs",
  security: adminSession,
  statusDescription: "Log tail",
});

registerJsonRouteMetadata({
  method: "post",
  path: "/api/v1/signer/control",
  tags: ["Signer"],
  summary: "Signer control actions",
  security: adminSession,
  statusDescription: "Control result",
  withErrors: true,
});

registerJsonRouteMetadata({
  method: "get",
  path: "/api/v1/billing",
  tags: ["Billing"],
  summary: "Platform billing overview",
  security: adminSession,
  statusDescription: "Billing overview",
});

registerJsonRouteMetadata({
  method: "get",
  path: "/api/v1/end-users",
  tags: ["Users"],
  summary: "List end users",
  security: adminSession,
  statusDescription: "End users",
});

registerJsonRouteMetadata({
  method: "post",
  path: "/api/v1/end-users",
  tags: ["Users"],
  summary: "Create end user",
  security: adminSession,
  status: 201,
});

registerJsonRouteMetadata({
  method: "get",
  path: "/api/v1/prices/eth-usd",
  tags: ["Platform"],
  summary: "ETH/USD spot price",
  statusDescription: "Price snapshot",
});
