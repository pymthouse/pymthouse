/**
 * Register a Turnkey balance webhook endpoint for TicketBroker auto-funding.
 *
 * Usage:
 *   npm run turnkey:create-webhook
 *   npm run turnkey:create-webhook -- --url https://pymthouse.com/webhooks/turnkey-balance
 *
 * Required env (from Railway signer or .env.local):
 *   TURNKEY_ORG_ID
 *   TURNKEY_API_PUBLIC_KEY
 *   TURNKEY_API_PRIVATE_KEY
 *
 * Optional:
 *   TURNKEY_API_HOST (default api.turnkey.com)
 *   TURNKEY_FUNDING_WEBHOOK_URL (default ${NEXTAUTH_URL}/webhooks/turnkey-balance)
 *   TURNKEY_FUNDING_WEBHOOK_NAME (default pymthouse-ticketbroker-funding)
 *
 * End-to-end verification (staging/prod):
 *   1. Deploy pymthouse with SIGNER_CLI_URL pointing at /__signer_cli on Railway.
 *   2. Run this script to register the webhook with Turnkey.
 *   3. Send a small ETH amount (> TICKET_FUNDING_MIN_WEI + buffer) to SIGNER_ETH_ADDR
 *      on Arbitrum One (0x6CAE...7260 in production).
 *   4. Confirm POST /webhooks/turnkey-balance returns { status: "funded" } in Vercel logs.
 *   5. Check turnkey_funding_events row status=funded for the idempotency key.
 *   6. Confirm deposit increased via GET /api/v1/signer/cli-status (senderInfo.deposit).
 */

import "./load-env-first";
import { Turnkey } from "@turnkey/sdk-server";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

function resolveWebhookUrl(): string {
  const argIndex = process.argv.indexOf("--url");
  if (argIndex >= 0) {
    const fromArg = process.argv[argIndex + 1]?.trim();
    if (fromArg) return fromArg;
  }

  const explicit = process.env.TURNKEY_FUNDING_WEBHOOK_URL?.trim();
  if (explicit) return explicit;

  const base = process.env.NEXTAUTH_URL?.trim();
  if (!base) {
    console.error(
      "Set TURNKEY_FUNDING_WEBHOOK_URL or NEXTAUTH_URL, or pass --url.",
    );
    process.exit(1);
  }
  return `${base.replace(/\/$/, "")}/webhooks/turnkey-balance`;
}

async function main() {
  const organizationId = requireEnv("TURNKEY_ORG_ID");
  const apiPublicKey = requireEnv("TURNKEY_API_PUBLIC_KEY");
  const apiPrivateKey = requireEnv("TURNKEY_API_PRIVATE_KEY");
  const apiHost = process.env.TURNKEY_API_HOST?.trim() || "api.turnkey.com";
  const webhookUrl = resolveWebhookUrl();
  const webhookName =
    process.env.TURNKEY_FUNDING_WEBHOOK_NAME?.trim() ||
    "pymthouse-ticketbroker-funding";

  const turnkey = new Turnkey({
    apiBaseUrl: `https://${apiHost}`,
    apiPublicKey,
    apiPrivateKey,
    defaultOrganizationId: organizationId,
  });

  console.log(`Creating Turnkey webhook endpoint: ${webhookUrl}`);
  const response = await turnkey.apiClient().createWebhookEndpoint({
    url: webhookUrl,
    name: webhookName,
    subscriptions: [
      {
        eventType: "BALANCE_FINALIZED_UPDATES",
        isActive: true,
      },
    ],
  });

  const activity = response.activity;
  const result = activity?.result?.createWebhookEndpointResult;
  console.log("\nWebhook endpoint created:");
  console.log(JSON.stringify(
    {
      activityId: activity?.id,
      status: activity?.status,
      webhookEndpointId: result?.webhookEndpointId,
      url: webhookUrl,
      eventType: "BALANCE_FINALIZED_UPDATES",
    },
    null,
    2,
  ));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
