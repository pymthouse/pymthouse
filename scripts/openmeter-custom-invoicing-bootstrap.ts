/**
 * Bootstrap Konnect Custom Invoicing for the merchant plane:
 * 1. Notification webhook channel → settlement producer (required URL)
 * 2. Install Custom Invoicing app (hooks disabled initially)
 * 3. Non-default merchant billing profile referencing that app
 * 4. Invoice created + updated notification rules
 *
 * E2E mode (`--e2e` or SETTLEMENT_E2E_BOOTSTRAP=1): only provisions an isolated
 * notification channel + invoice rules named with an `-e2e` suffix. Skips
 * Custom Invoicing app install and merchant billing profile so production
 * Konnect config is untouched. Uses SETTLEMENT_E2E_* webhook URL/secrets —
 * never SETTLEMENT_OPENMETER_WEBHOOK_URL.
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
import { merchantSettlementMetadata } from "../src/lib/openmeter/settlement-metadata";
import { sanitizeForLog } from "../src/lib/sanitize-for-log";
import {
  getHostedOpenMeterUrl,
  isKonnectMeteringUrl,
  normalizeKonnectMeteringUrl,
} from "../src/lib/openmeter/constants";

const CHANNEL_NAME = "pymthouse-merchant-invoices";
const CHANNEL_NAME_E2E = "pymthouse-merchant-invoices-e2e";
const PROFILE_NAME = "pymthouse-merchant-custom-invoicing";
/** Matches `e2e.connect_account_id` in testdata/pymthouse-settlement-metadata.json. */
const E2E_CONNECT_ACCOUNT_ID = "acct_e2e_settlement";

function isE2eBootstrap(): boolean {
  if (process.env.SETTLEMENT_E2E_BOOTSTRAP?.trim() === "1") {
    return true;
  }
  return process.argv.includes("--e2e");
}

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
 * E2E mode uses SETTLEMENT_E2E_OPENMETER_WEBHOOK_URL only.
 */
function requireSettlementOpenMeterWebhookUrl(e2e: boolean): string {
  if (e2e) {
    const url = process.env.SETTLEMENT_E2E_OPENMETER_WEBHOOK_URL?.trim() || "";
    if (!url.startsWith("https://")) {
      throw new Error(
        "SETTLEMENT_E2E_OPENMETER_WEBHOOK_URL must be the https URL of the " +
          "e2e settlement OpenMeter webhook ingress " +
          "(do not use production SETTLEMENT_OPENMETER_WEBHOOK_URL).",
      );
    }
    return url.replace(/\/$/, "");
  }
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

function resolveWebhookSigningSecret(e2e: boolean): string {
  if (e2e) {
    return (
      process.env.SETTLEMENT_E2E_OPENMETER_WEBHOOK_SECRETS?.split(",")[0]?.trim() ||
      newWebhookSigningSecret()
    );
  }
  return (
    process.env.SETTLEMENT_OPENMETER_WEBHOOK_SECRETS?.split(",")[0]?.trim() ||
    process.env.OPENMETER_WEBHOOK_SECRET?.trim() ||
    newWebhookSigningSecret()
  );
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
  channelName: string;
  url: string;
  webhookSecret: string;
  secretsEnvVar: string;
}): Promise<{
  channelId: string;
  created: boolean;
  signingSecret: string;
}> {
  // E2E: match by name only so a shared URL cannot select the production channel.
  // Prod: also allow URL match for channels created before the fixed name existed.
  const existing = (await listNotificationChannels()).find((ch) => {
    if (ch.name === input.channelName) {
      return true;
    }
    if (input.channelName === CHANNEL_NAME_E2E) {
      return false;
    }
    return ch.url === input.url;
  });
  if (existing?.id) {
    const existingUrl = existing.url?.trim();
    if (existingUrl && existingUrl !== input.url) {
      throw new Error(
        `Notification channel ${existing.id} (${input.channelName}) points at ` +
          `${existingUrl}, not ${input.url}. Update or delete it in Konnect, then re-run.`,
      );
    }
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
          `${input.secretsEnvVar} to the channel secret from the UI.`,
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
        name: input.channelName,
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

async function ensureInvoiceRules(
  channelId: string,
  e2e: boolean,
): Promise<void> {
  for (const type of ["invoice.created", "invoice.updated"] as const) {
    const name = e2e ? `pymthouse-e2e-${type}` : `pymthouse-${type}`;
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
      if (/\(409\)|\(400\).*already|duplicate/i.test(message)) {
        return;
      }
      throw err instanceof Error ? err : new Error(message);
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
  const e2e = isE2eBootstrap();
  requireKonnect();

  const channelName = e2e ? CHANNEL_NAME_E2E : CHANNEL_NAME;
  const secretsEnvVar = e2e
    ? "SETTLEMENT_E2E_OPENMETER_WEBHOOK_SECRETS"
    : "SETTLEMENT_OPENMETER_WEBHOOK_SECRETS";
  const webhookSecret = resolveWebhookSigningSecret(e2e);
  const webhookUrl = requireSettlementOpenMeterWebhookUrl(e2e);

  if (e2e) {
    console.log("[bootstrap] E2E mode — channel + rules only (skip app/profile)");
  }

  console.log(
    `[bootstrap] Ensuring notification channel (${channelName}) →`,
    sanitizeForLog(webhookUrl),
  );
  const {
    channelId,
    created: channelCreated,
    signingSecret,
  } = await ensureNotificationChannel({
    channelName,
    url: webhookUrl,
    webhookSecret,
    secretsEnvVar,
  });
  console.log(
    `[bootstrap] Channel ${sanitizeForLog(channelId)} (${channelCreated ? "created" : "existing"})`,
  );

  console.log(
    `[bootstrap] Ensuring ${e2e ? "pymthouse-e2e-" : "pymthouse-"}invoice.created / invoice.updated rules…`,
  );
  await ensureInvoiceRules(channelId, e2e);

  if (e2e) {
    const connectAccountId =
      process.env.SETTLEMENT_E2E_CONNECT_ACCOUNT_ID?.trim() ||
      E2E_CONNECT_ACCOUNT_ID;
    const stamp = merchantSettlementMetadata({
      chargeModel: "direct",
      connectedAccountId: connectAccountId,
    });
    console.log("\nE2E channel configured. Set on settlement e2e producer:\n");
    if (channelCreated) {
      console.log(
        `SETTLEMENT_E2E_OPENMETER_WEBHOOK_SECRETS=${sanitizeForLog(signingSecret)}`,
      );
    } else {
      console.log(
        "SETTLEMENT_E2E_OPENMETER_WEBHOOK_SECRETS=<use existing e2e channel secret; not re-printed>",
      );
    }
    console.log(
      `SETTLEMENT_E2E_OPENMETER_WEBHOOK_URL=${sanitizeForLog(webhookUrl)}`,
    );
    console.log(
      "\nStamp merchant invoices / customers with settlement metadata:\n",
    );
    console.log(JSON.stringify(stamp, null, 2));
    console.log(
      "\n(chargeModel=direct, connectedAccountId=" +
        sanitizeForLog(connectAccountId) +
        " via merchantSettlementMetadata)",
    );
    return;
  }

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
  if (channelCreated) {
    console.log(
      `SETTLEMENT_OPENMETER_WEBHOOK_SECRETS=${sanitizeForLog(signingSecret)}`,
    );
  } else {
    console.log(
      "SETTLEMENT_OPENMETER_WEBHOOK_SECRETS=<use existing channel secret; not re-printed>",
    );
  }
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
