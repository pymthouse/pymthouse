/**
 * Bootstrap Konnect Custom Invoicing for the merchant plane:
 * 1. Notification webhook channel → settlement producer (required URL)
 * 2. Install Custom Invoicing app (hooks disabled initially)
 * 3. Non-default merchant billing profile referencing that app
 * 4. Invoice created + updated notification rules
 *
 * Collection is owned by pymthouse/settlement (Kafka producer + Go worker).
 * This script only provisions OM/Konnect side config for pymthouse.
 *
 * Prints env vars to set: OPENMETER_CUSTOM_INVOICING_APP_ID,
 * OPENMETER_MERCHANT_BILLING_PROFILE_ID.
 *
 * Notifications + marketplace install live on Konnect `/metering/v1`
 * (not `/v3/openmeter`). Channels sign with Standard Webhooks / Svix via
 * `signingSecret` — do NOT put the secret in `customHeaders`; the settlement
 * producer verifies `webhook-signature` / `svix-signature`, not a custom header.
 *
 * @see https://github.com/pymthouse/settlement
 * @see https://developer.konghq.com/metering-and-billing/custom-invoicing/
 * @see https://developer.konghq.com/metering-and-billing/notifications/
 */
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

import {
  createKonnectMerchantCustomInvoicingProfile,
  listKonnectApps,
  listKonnectBillingProfiles,
  resolveKonnectCustomInvoicingAppId,
  selectKonnectCustomInvoicingApp,
} from "../src/lib/openmeter/konnect-billing-profiles";
import { konnectMeteringV1Fetch } from "../src/lib/openmeter/konnect-admin-client";
import { sanitizeForLog } from "../src/lib/sanitize-for-log";
import {
  getHostedOpenMeterUrl,
  isKonnectMeteringUrl,
  normalizeKonnectMeteringUrl,
} from "../src/lib/openmeter/constants";

const CHANNEL_NAME = "pymthouse-merchant-invoices";
const PROFILE_NAME = "pymthouse-merchant-custom-invoicing";

/** metering/v1 list envelope (items + flat page fields). */
type MeteringV1Page<T> = {
  items?: T[];
  data?: T[];
  page?: number;
  pageSize?: number;
  totalCount?: number;
};

type NotificationChannel = {
  id?: string;
  name?: string;
  type?: string;
  url?: string;
  signingSecret?: string;
};

type MarketplaceInstallResponse = {
  app?: { id?: string };
  id?: string;
};

function requireKonnect(): { baseUrl: string; apiKey: string } {
  const apiKey = process.env.OPENMETER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENMETER_API_KEY is required");
  }
  const raw = getHostedOpenMeterUrl();
  if (!isKonnectMeteringUrl(raw, apiKey)) {
    throw new Error(
      "Custom Invoicing bootstrap targets Konnect Metering & Billing. " +
        "Set OPENMETER_URL to https://{region}.api.konghq.com/v3/openmeter",
    );
  }
  return { baseUrl: normalizeKonnectMeteringUrl(raw), apiKey };
}

/**
 * Public HTTPS URL of the settlement producer OpenMeter ingress
 * (e.g. https://settlement.example.com/webhooks/openmeter).
 */
function requireSettlementOpenMeterWebhookUrl(): string {
  const url =
    process.env.SETTLEMENT_OPENMETER_WEBHOOK_URL?.trim() ||
    process.env.OPENMETER_NOTIFICATION_WEBHOOK_URL?.trim() ||
    "";
  if (!url.startsWith("https://")) {
    throw new Error(
      "SETTLEMENT_OPENMETER_WEBHOOK_URL must be the https URL of the " +
        "pymthouse/settlement producer OpenMeter webhook ingress " +
        "(not a pymthouse app route).",
    );
  }
  return url.replace(/\/$/, "");
}

/**
 * Standard Webhooks / Svix secret: `whsec_` + base64 of ≥24 random bytes.
 * Matches Konnect's `^(whsec_)?[a-zA-Z0-9+/=]{32,100}$` pattern (std base64,
 * not base64url).
 */
function newWebhookSigningSecret(): string {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

function pageItems<T>(page: MeteringV1Page<T>): T[] {
  return page.items ?? page.data ?? [];
}

async function listNotificationChannels(): Promise<NotificationChannel[]> {
  const page = await konnectMeteringV1Fetch<MeteringV1Page<NotificationChannel>>(
    "/notification/channels?pageSize=100",
  );
  return pageItems(page);
}

async function getNotificationChannel(
  channelId: string,
): Promise<NotificationChannel> {
  return konnectMeteringV1Fetch<NotificationChannel>(
    `/notification/channels/${encodeURIComponent(channelId)}`,
  );
}

async function ensureNotificationChannel(input: {
  url: string;
  webhookSecret: string;
}): Promise<{
  channelId: string;
  created: boolean;
  signingSecret: string;
}> {
  const existing = (await listNotificationChannels()).find(
    (ch) => ch.name === CHANNEL_NAME || ch.url === input.url,
  );
  if (existing?.id) {
    // Prefer the channel's real signing secret over whatever we invented.
    const fresh =
      existing.signingSecret != null && existing.signingSecret !== ""
        ? existing
        : await getNotificationChannel(existing.id);
    const signingSecret = fresh.signingSecret?.trim();
    if (!signingSecret) {
      throw new Error(
        `Notification channel ${existing.id} exists but has no signingSecret. ` +
          "Delete it in Konnect and re-run bootstrap, or set " +
          "SETTLEMENT_OPENMETER_WEBHOOK_SECRETS to the channel secret from the UI.",
      );
    }
    return {
      channelId: existing.id,
      created: false,
      signingSecret,
    };
  }

  const created = await konnectMeteringV1Fetch<NotificationChannel>(
    "/notification/channels",
    {
      method: "POST",
      body: JSON.stringify({
        type: "WEBHOOK",
        name: CHANNEL_NAME,
        url: input.url,
        // Standard Webhooks / Svix signing — settlement verifies webhook-signature.
        signingSecret: input.webhookSecret,
        disabled: false,
      }),
    },
    "notification",
  );
  if (!created.id) {
    throw new Error("Failed to create notification channel");
  }
  const signingSecret =
    created.signingSecret?.trim() || input.webhookSecret;
  return {
    channelId: created.id,
    created: true,
    signingSecret,
  };
}

async function ensureInvoiceRules(channelId: string): Promise<void> {
  for (const type of ["invoice.created", "invoice.updated"] as const) {
    const name = `pymthouse-${type}`;
    await konnectMeteringV1Fetch(
      "/notification/rules",
      {
        method: "POST",
        body: JSON.stringify({
          type,
          name,
          channels: [channelId],
          disabled: false,
        }),
      },
      "notification",
    ).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      // Idempotent: rule may already exist.
      if (!/\(409\)|\(400\).*already|duplicate/i.test(message)) {
        console.warn(`[bootstrap] rule ${type}: ${message}`);
      }
    });
  }
}

async function installCustomInvoicingApp(): Promise<string> {
  const apps = await listKonnectApps();
  const existing = selectKonnectCustomInvoicingApp(apps);
  if (existing) {
    return existing;
  }

  const installed = await konnectMeteringV1Fetch<MarketplaceInstallResponse>(
    "/marketplace/listings/custom_invoicing/install",
    {
      method: "POST",
      body: JSON.stringify({
        name: "PymtHouse Custom Invoicing",
        // Hooks off initially per Kong docs; payment status sync is always mandatory.
        // Turn enableDraftSyncHook + enableIssuingSyncHook ON in Konnect after
        // the settlement worker is live (PUT /metering/v1/apps/{id}).
        enableDraftSyncHook: false,
        enableIssuingSyncHook: false,
      }),
    },
    "marketplace",
  );
  const appId = installed.app?.id ?? installed.id;
  if (!appId) {
    throw new Error("Marketplace install did not return a Custom Invoicing app id");
  }
  return appId;
}

async function ensureMerchantProfile(appId: string): Promise<string> {
  const envId = process.env.OPENMETER_MERCHANT_BILLING_PROFILE_ID?.trim();
  if (envId) {
    return envId;
  }
  const profiles = await listKonnectBillingProfiles();
  const existing = profiles.find((p) => p.name === PROFILE_NAME);
  if (existing?.id) {
    return existing.id;
  }
  return createKonnectMerchantCustomInvoicingProfile({
    customInvoicingAppId: appId,
    name: PROFILE_NAME,
    progressiveBilling: true,
    collectionMethod: "charge_automatically",
  });
}

async function main(): Promise<void> {
  requireKonnect();

  const webhookSecret =
    process.env.SETTLEMENT_OPENMETER_WEBHOOK_SECRETS?.split(",")[0]?.trim() ||
    process.env.OPENMETER_WEBHOOK_SECRET?.trim() ||
    newWebhookSigningSecret();
  const webhookUrl = requireSettlementOpenMeterWebhookUrl();

  console.log(
    "[bootstrap] Ensuring notification channel →",
    sanitizeForLog(webhookUrl),
  );
  const { channelId, created, signingSecret } = await ensureNotificationChannel({
    url: webhookUrl,
    webhookSecret,
  });
  console.log(
    `[bootstrap] Channel ${sanitizeForLog(channelId)} (${created ? "created" : "existing"})`,
  );

  console.log("[bootstrap] Installing / resolving Custom Invoicing app…");
  let appId: string;
  try {
    appId = await installCustomInvoicingApp();
  } catch (err) {
    console.warn(
      `[bootstrap] Marketplace install failed (${sanitizeForLog(err)}); resolving existing…`,
    );
    appId = await resolveKonnectCustomInvoicingAppId();
  }
  console.log("[bootstrap] Custom Invoicing app:", sanitizeForLog(appId));

  console.log("[bootstrap] Ensuring merchant billing profile (non-default)…");
  const profileId = await ensureMerchantProfile(appId);
  console.log(
    "[bootstrap] Merchant billing profile:",
    sanitizeForLog(profileId),
  );

  console.log("[bootstrap] Ensuring invoice.created / invoice.updated rules…");
  await ensureInvoiceRules(channelId);

  console.log("\nSet these env vars on pymthouse (Vercel):\n");
  console.log(
    `OPENMETER_CUSTOM_INVOICING_APP_ID=${sanitizeForLog(appId)}`,
  );
  console.log(
    `OPENMETER_MERCHANT_BILLING_PROFILE_ID=${sanitizeForLog(profileId)}`,
  );
  console.log(
    "\nConfigure the channel signing secret on pymthouse/settlement producer:\n",
  );
  console.log(
    `SETTLEMENT_OPENMETER_WEBHOOK_SECRETS=${sanitizeForLog(signingSecret)}`,
  );
  console.log(
    "\nThen enable draft + issuing sync hooks on the Custom Invoicing app in Konnect",
  );
  console.log(
    "(PUT /metering/v1/apps/{id} with enableDraftSyncHook/enableIssuingSyncHook true).",
  );
  console.log(
    "\nPin merchant-mode end-user customers via assignMerchantCustomInvoicingProfile",
  );
  console.log(
    "(never set the merchant profile as the org default — use customer overrides).",
  );
}

main().catch((err) => {
  console.error("[bootstrap] failed:", err);
  process.exit(1);
});
