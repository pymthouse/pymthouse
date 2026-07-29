import { defineRouteMetadata } from "@/lib/openapi/route-metadata";
import { OPENAPI_TAGS } from "@/lib/openapi/tags";
import { z } from "@/lib/openapi/zod";

const NetworkAgentChallengeResponseSchema = z
  .object({
    challengeId: z.string().uuid(),
    nonce: z.string(),
    expiresAt: z.string().datetime(),
    alg: z.literal("Ed25519"),
  })
  .openapi("NetworkAgentChallengeResponse");

const NetworkAgentRegisterRequestSchema = z
  .object({
    publicKey: z.string().openapi({
      description:
        "Ed25519 public key (32-byte raw hex/base64, or SPKI). Same key used for the challenge.",
    }),
    challengeId: z.string().uuid(),
    signature: z.string().openapi({
      description:
        "Ed25519 signature over the challenge nonce (UTF-8), hex or base64, 64 bytes.",
    }),
    label: z.string().optional().openapi({
      description: "Optional API key label (default: agent-network-key).",
    }),
  })
  .openapi("NetworkAgentRegisterRequest");

const NetworkAgentRegisterResponseSchema = z
  .object({
    clientId: z.string(),
    externalUserId: z.string(),
    apiKey: z.string(),
    sdkToken: z.string().nullable(),
    id: z.string(),
    prefix: z.string(),
    suffix: z.string(),
    label: z.string().nullable(),
    message: z.string(),
    correlation_id: z.string(),
  })
  .openapi("NetworkAgentRegisterResponse");

defineRouteMetadata("get", "/api/v1/network/register/challenge", {
  tags: [OPENAPI_TAGS.network],
  summary: "Agent network registration challenge",
  description:
    "Issue a short-lived Ed25519 challenge for headless agent registration on the platform default app. Gated by `NETWORK_AGENT_REGISTER_ENABLED`.",
  request: {
    query: z.object({
      publicKey: z.string().openapi({
        param: { name: "publicKey", in: "query" },
        description: "Ed25519 public key (hex or base64).",
      }),
    }),
  },
  responses: {
    200: {
      description: "Challenge issued",
      content: {
        "application/json": { schema: NetworkAgentChallengeResponseSchema },
      },
    },
    400: { description: "Missing or invalid publicKey" },
    404: { description: "Feature disabled" },
    429: { description: "Rate limited" },
  },
});

defineRouteMetadata("post", "/api/v1/network/register", {
  tags: [OPENAPI_TAGS.network],
  summary: "Register network agent",
  description:
    "Prove Ed25519 key possession and mint a one-time composite API key on the platform default app. Does not create a dashboard/Turnkey `users` account. Gated by `NETWORK_AGENT_REGISTER_ENABLED`.",
  request: {
    body: {
      content: {
        "application/json": { schema: NetworkAgentRegisterRequestSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Registered; API key shown once",
      content: {
        "application/json": { schema: NetworkAgentRegisterResponseSchema },
      },
    },
    400: { description: "Invalid body or challenge" },
    401: { description: "Bad signature" },
    404: { description: "Feature disabled" },
    409: { description: "Public key already registered" },
    429: { description: "Rate limited" },
  },
});
