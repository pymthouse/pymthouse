import { defineRouteMetadata } from "@/lib/openapi/route-metadata";

defineRouteMetadata("get", "/api/v1/x402/supported", {
  tags: ["x402"],
  summary: "List supported x402 schemes and networks",
  description:
    "Public discovery endpoint for the PymtHouse x402 facilitator (exact scheme, Arbitrum USDC).",
  responses: {
    200: { description: "Supported payment kinds and facilitator signers" },
  },
});

defineRouteMetadata("post", "/api/v1/x402/verify", {
  tags: ["x402"],
  summary: "Verify an x402 payment payload",
  description:
    "Validates an EIP-3009 TransferWithAuthorization payload against payment requirements. Accepts M2M Basic, public app_* client_id (rate-limited), or bearer JWT.",
  responses: {
    200: { description: "Verification result" },
    400: { description: "Invalid request body" },
    401: { description: "Unauthorized" },
    403: { description: "x402 not enabled for app" },
    429: { description: "Rate limited (public client)" },
  },
});

defineRouteMetadata("post", "/api/v1/x402/settle", {
  tags: ["x402"],
  summary: "Settle an x402 payment on-chain",
  description:
    "Submits transferWithAuthorization on Arbitrum USDC and optionally grants OpenMeter prepaid credits. Requires M2M Basic with x402:settle scope.",
  responses: {
    200: { description: "Settlement succeeded" },
    400: { description: "Invalid request body" },
    401: { description: "Unauthorized" },
    402: { description: "Settlement failed" },
    403: { description: "Missing scope or x402 not enabled" },
  },
});

defineRouteMetadata("post", "/api/v1/x402/payment-codes", {
  tags: ["x402"],
  summary: "Create a payment approval code",
  description:
    "Device-code-style payment intent for agents. Human sponsor approves on /x402/approve. Accepts public app_* client_id, bearer JWT, or M2M Basic.",
  responses: {
    201: { description: "Payment code created" },
    400: { description: "Invalid request" },
    401: { description: "Unauthorized" },
    403: { description: "x402 not enabled" },
    429: { description: "Rate limited" },
  },
});

defineRouteMetadata("get", "/api/v1/x402/payment-codes/{code}", {
  tags: ["x402"],
  summary: "Poll a payment approval code",
  description:
    "Agent polls until the human sponsor approves and a signed PaymentPayload is available.",
  responses: {
    200: { description: "Payment code status" },
    401: { description: "Unauthorized" },
    404: { description: "Not found" },
  },
});

defineRouteMetadata("post", "/api/v1/x402/payment-codes/{code}/approve", {
  tags: ["x402"],
  summary: "Approve a payment code with a signed payload",
  description:
    "Browser session posts the Wallet Kit–signed EIP-3009 PaymentPayload after human approval.",
  responses: {
    200: { description: "Approved" },
    400: { description: "Invalid payload" },
    401: { description: "Unauthorized" },
    404: { description: "Not found" },
  },
});

defineRouteMetadata("post", "/api/v1/apps/{clientId}/x402/wallet", {
  tags: ["x402"],
  summary: "Provision or assign an x402 deposit wallet",
  description:
    "M2M endpoint to request/assign a deposit wallet for the app (payTo) or the M2M client.",
  responses: {
    200: { description: "Wallet address" },
    401: { description: "Unauthorized" },
    403: { description: "x402 not enabled or missing scope" },
  },
});
