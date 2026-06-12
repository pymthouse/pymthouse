import { resolveHostedOpenMeterBaseUrl } from "./route-mode";

type KonnectEntitlementAccessRow = {
  feature_key?: string;
  has_access?: boolean;
};

type KonnectEntitlementAccessResponse = {
  data?: KonnectEntitlementAccessRow[];
};

export async function getKonnectEntitlementHasAccess(input: {
  customerId: string;
  featureKey: string;
  apiKey?: string;
}): Promise<boolean | null> {
  const apiKey = input.apiKey?.trim() || process.env.OPENMETER_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }

  const baseUrl = resolveHostedOpenMeterBaseUrl(apiKey);
  const response = await fetch(
    `${baseUrl}/customers/${encodeURIComponent(input.customerId)}/entitlement-access`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );

  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(
      `Konnect entitlement-access failed (${response.url}) [${response.status}]: ${await response.text()}`,
    );
  }

  const body = (await response.json()) as KonnectEntitlementAccessResponse;
  const row = (body.data ?? []).find((item) => item.feature_key === input.featureKey);
  return row?.has_access ?? false;
}
