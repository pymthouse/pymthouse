import { resolveHostedOpenMeterBaseUrl } from "./route-mode";

type KonnectEntitlementAccessRow = {
  feature_key?: string;
  has_access?: boolean;
};

type KonnectEntitlementAccessResponse = {
  data?: KonnectEntitlementAccessRow[];
};

const ENTITLEMENT_ACCESS_TIMEOUT_MS = 20_000;

export async function getKonnectEntitlementHasAccess(input: {
  customerId: string;
  featureKey: string;
  apiKey?: string;
}): Promise<boolean | null> {
  const customerId = input.customerId.trim();
  const featureKey = input.featureKey.trim();
  if (!customerId) {
    throw new Error("getKonnectEntitlementHasAccess: customerId must be non-empty");
  }
  if (!featureKey) {
    throw new Error("getKonnectEntitlementHasAccess: featureKey must be non-empty");
  }

  const apiKey = input.apiKey?.trim() || process.env.OPENMETER_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }

  const baseUrl = resolveHostedOpenMeterBaseUrl(apiKey);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ENTITLEMENT_ACCESS_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(
      `${baseUrl}/customers/${encodeURIComponent(customerId)}/entitlement-access`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Konnect entitlement-access timed out after ${ENTITLEMENT_ACCESS_TIMEOUT_MS / 1000}s`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(
      `Konnect entitlement-access failed (${response.url}) [${response.status}]: ${await response.text()}`,
    );
  }

  const body = (await response.json()) as KonnectEntitlementAccessResponse;
  const row = (body.data ?? []).find((item) => item.feature_key === featureKey);
  return row?.has_access ?? false;
}
