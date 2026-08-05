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
import { konnectAdminFetch } from "../src/lib/openmeter/konnect-admin-client";
import {
  getHostedOpenMeterUrl,
  isKonnectMeteringUrl,
  normalizeKonnectMeteringUrl,
} from "../src/lib/openmeter/constants";

const CHANNEL_NAME = "pymthouse-merchant-invoices";
const PROFILE_NAME = "pymthouse-merchant-custom-invoicing";

type KonnectPage<T> = { data?: T[] };

type NotificationChannel = {
  id?: string;
  name?: string;
  type?: string;
  url?: string;
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

async function listNotificationChannels(): Promise<NotificationChannel[]> {
  const page = await konnectAdminFetch<KonnectPage<NotificationChannel>>(
    "/notification/channels?page[size]=100",
  );
  return page.data ?? [];
}

async function ensureNotificationChannel(input: {
  url: string;
  webhookSecret: string;
}): Promise<{ channelId: string; created: boolean }> {
  const existing = (await listNotificationChannels()).find(
    (ch) => ch.name === CHANNEL_NAME || ch.url === input.url,
  );
  if (existing?.id) {
    return { channelId: existing.id, created: false };
  }

  const created = await konnectAdminFetch<NotificationChannel>(
    "/notification/channels",
    {
      method: "POST",
      body: JSON.stringify({
        type: "WEBHOOK",
        name: CHANNEL_NAME,
        url: input.url,
        customHeaders: {
          "X-Webhook-Secret": input.webhookSecret,
        },
        disabled: false,
      }),
    },
    "notification",
  );
  if (!created.id) {
    throw new Error("Failed to create notification channel");
  }
  return { channelId: created.id, created: true };
}

async function ensureInvoiceRules(channelId: string): Promise<void> {
  for (const type of ["invoice.created", "invoice.updated"] as const) {
    const name = `pymthouse-${type}`;
    await konnectAdminFetch(
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

  const installed = await konnectAdminFetch<MarketplaceInstallResponse>(
    "/marketplace/listings/custom_invoicing/install",
    {
      method: "POST",
      body: JSON.stringify({
        name: "PymtHouse Custom Invoicing",
        // Hooks off initially per Kong docs; payment status sync is always mandatory.
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
    `whsec_${randomBytes(24).toString("base64url")}`;
  const webhookUrl = requireSettlementOpenMeterWebhookUrl();

  console.log("[bootstrap] Ensuring notification channel →", webhookUrl);
  const { channelId, created } = await ensureNotificationChannel({
    url: webhookUrl,
    webhookSecret,
  });
  console.log(
    `[bootstrap] Channel ${channelId} (${created ? "created" : "existing"})`,
  );

  console.log("[bootstrap] Installing / resolving Custom Invoicing app…");
  let appId: string;
  try {
    appId = await installCustomInvoicingApp();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[bootstrap] Marketplace install failed (${message}); resolving existing…`);
    appId = await resolveKonnectCustomInvoicingAppId();
  }
  console.log("[bootstrap] Custom Invoicing app:", appId);

  console.log("[bootstrap] Ensuring merchant billing profile (non-default)…");
  const profileId = await ensureMerchantProfile(appId);
  console.log("[bootstrap] Merchant billing profile:", profileId);

  console.log("[bootstrap] Ensuring invoice.created / invoice.updated rules…");
  await ensureInvoiceRules(channelId);

  console.log("\nSet these env vars on pymthouse (Vercel):\n");
  console.log(`OPENMETER_CUSTOM_INVOICING_APP_ID=${appId}`);
  console.log(`OPENMETER_MERCHANT_BILLING_PROFILE_ID=${profileId}`);
  console.log(
    "\nConfigure the same webhook secret on pymthouse/settlement producer:\n",
  );
  console.log(`SETTLEMENT_OPENMETER_WEBHOOK_SECRETS=${webhookSecret}`);
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
