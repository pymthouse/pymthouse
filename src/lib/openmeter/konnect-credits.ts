import { resolveHostedOpenMeterBaseUrl } from "./route-mode";

const CREDITS_TIMEOUT_MS = 20_000;
const MICROS_PER_DOLLAR = 1_000_000n;

type KonnectCreditBalanceRow = {
  currency?: string;
  live?: string;
  settled?: string;
  pending?: string;
};

type KonnectCreditBalanceResponse = {
  balances?: KonnectCreditBalanceRow[];
  retrieved_at?: string;
};

export type KonnectCreditGrantRow = {
  id?: string;
  amount?: string;
  currency?: string;
  status?: string;
  name?: string;
  key?: string;
  /**
   * Konnect has used both snake_case and camelCase for grant timestamps across
   * revisions; accept either so the ledger can place grants chronologically.
   * All optional — an undated grant is skipped rather than mis-ordered.
   */
  effective_at?: string;
  effectiveAt?: string;
  created_at?: string;
  createdAt?: string;
};

/** First usable ISO timestamp on a grant row, or null when undated. */
export function konnectGrantTimestamp(
  grant: KonnectCreditGrantRow,
): string | null {
  const candidates = [
    grant.effective_at,
    grant.effectiveAt,
    grant.created_at,
    grant.createdAt,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) continue;
    // Normalize so localeCompare ordering against ISO usage/invoice dates works.
    return new Date(ms).toISOString();
  }
  return null;
}

type KonnectCreditGrantsListResponse = {
  data?: KonnectCreditGrantRow[];
};

export type KonnectCreditBalance = {
  balanceUsdMicros: bigint;
  lifetimeGrantedUsdMicros: bigint;
  consumedUsdMicros: bigint;
};

/** Convert USD micros to Konnect decimal dollar string (e.g. 5000000 → "5"). */
export function usdMicrosToDecimalDollars(amountUsdMicros: bigint): string {
  if (amountUsdMicros < 0n) {
    throw new Error("usdMicrosToDecimalDollars: amount must be non-negative");
  }
  const whole = amountUsdMicros / MICROS_PER_DOLLAR;
  const frac = amountUsdMicros % MICROS_PER_DOLLAR;
  if (frac === 0n) {
    return whole.toString();
  }
  const padded = frac.toString().padStart(6, "0");
  let end = padded.length;
  while (end > 0 && padded[end - 1] === "0") {
    end -= 1;
  }
  return `${whole}.${padded.slice(0, end)}`;
}

/**
 * Convert Konnect decimal dollar string to USD micros (e.g. "5.00" → 5000000n).
 *
 * Truncates toward zero past 6 fractional digits so remaining credit never
 * invents an extra micro the ledger did not grant. Round-trips with
 * {@link usdMicrosToDecimalDollars} for integer micros (including 1 and 34).
 */
export function decimalDollarsToUsdMicros(raw: string): bigint {
  const trimmed = raw.trim();
  if (!trimmed || !/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`decimalDollarsToUsdMicros: invalid amount "${raw}"`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart, fracPart = ""] = unsigned.split(".");
  const whole = BigInt(wholePart || "0");
  const fracDigits = (fracPart + "000000").slice(0, 6);
  const frac = BigInt(fracDigits);
  const micros = whole * MICROS_PER_DOLLAR + frac;
  return negative ? -micros : micros;
}

function resolveApiKey(apiKey?: string): string | null {
  return apiKey?.trim() || process.env.OPENMETER_API_KEY?.trim() || null;
}

async function konnectCreditsFetch(
  path: string,
  init: RequestInit,
  apiKey: string,
): Promise<Response> {
  const baseUrl = resolveHostedOpenMeterBaseUrl(apiKey);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CREDITS_TIMEOUT_MS);
  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...init.headers,
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Konnect credits request timed out after ${CREDITS_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function listKonnectCreditGrants(input: {
  customerId: string;
  apiKey?: string;
}): Promise<KonnectCreditGrantRow[]> {
  const customerId = input.customerId.trim();
  if (!customerId) {
    throw new Error("listKonnectCreditGrants: customerId must be non-empty");
  }
  const apiKey = resolveApiKey(input.apiKey);
  if (!apiKey) {
    return [];
  }

  const pageSize = 100;
  const maxPages = 50;
  const grants: KonnectCreditGrantRow[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const params = new URLSearchParams();
    params.set("page[size]", String(pageSize));
    params.set("page[number]", String(page));
    const response = await konnectCreditsFetch(
      `/customers/${encodeURIComponent(customerId)}/credits/grants?${params}`,
      { method: "GET" },
      apiKey,
    );
    if (response.status === 404) {
      return grants;
    }
    if (!response.ok) {
      throw new Error(
        `Konnect credits/grants list failed (${response.url}) [${response.status}]: ${await response.text()}`,
      );
    }
    const body = (await response.json()) as KonnectCreditGrantsListResponse;
    const batch = body.data ?? [];
    grants.push(...batch);
    if (batch.length < pageSize) {
      break;
    }
  }
  return grants;
}

export async function getKonnectCreditBalance(input: {
  customerId: string;
  currency?: string;
  apiKey?: string;
}): Promise<KonnectCreditBalance | null> {
  const customerId = input.customerId.trim();
  if (!customerId) {
    throw new Error("getKonnectCreditBalance: customerId must be non-empty");
  }
  const apiKey = resolveApiKey(input.apiKey);
  if (!apiKey) {
    return null;
  }

  const currency = (input.currency ?? "USD").trim().toUpperCase() || "USD";
  const params = new URLSearchParams();
  params.set("filter[currency][eq]", currency);

  const response = await konnectCreditsFetch(
    `/customers/${encodeURIComponent(customerId)}/credits/balance?${params}`,
    { method: "GET" },
    apiKey,
  );
  if (response.status === 404) {
    return {
      balanceUsdMicros: 0n,
      lifetimeGrantedUsdMicros: 0n,
      consumedUsdMicros: 0n,
    };
  }
  if (!response.ok) {
    throw new Error(
      `Konnect credits/balance failed (${response.url}) [${response.status}]: ${await response.text()}`,
    );
  }

  const body = (await response.json()) as KonnectCreditBalanceResponse;
  const row =
    (body.balances ?? []).find(
      (item) => (item.currency ?? "").toUpperCase() === currency,
    ) ?? body.balances?.[0];
  const balanceUsdMicros = decimalDollarsToUsdMicros(row?.live ?? "0");

  const grants = await listKonnectCreditGrants({
    customerId,
    apiKey,
  });
  let lifetimeGrantedUsdMicros = 0n;
  for (const grant of grants) {
    if (grant.status && grant.status !== "active") {
      continue;
    }
    if (grant.currency && grant.currency.toUpperCase() !== currency) {
      continue;
    }
    if (!grant.amount) {
      continue;
    }
    lifetimeGrantedUsdMicros += decimalDollarsToUsdMicros(grant.amount);
  }

  const consumedUsdMicros =
    lifetimeGrantedUsdMicros > balanceUsdMicros
      ? lifetimeGrantedUsdMicros - balanceUsdMicros
      : 0n;

  return {
    balanceUsdMicros: balanceUsdMicros > 0n ? balanceUsdMicros : 0n,
    lifetimeGrantedUsdMicros,
    consumedUsdMicros,
  };
}

export async function createKonnectCreditGrant(input: {
  customerId: string;
  amountUsdMicros: bigint;
  name: string;
  idempotencyKey: string;
  featureKey?: string;
  description?: string;
  expiresAfter?: string;
  apiKey?: string;
}): Promise<{ created: boolean; conflict: boolean }> {
  const customerId = input.customerId.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  const name = input.name.trim();
  if (!customerId) {
    throw new Error("createKonnectCreditGrant: customerId must be non-empty");
  }
  if (!idempotencyKey) {
    throw new Error("createKonnectCreditGrant: idempotencyKey must be non-empty");
  }
  if (!name) {
    throw new Error("createKonnectCreditGrant: name must be non-empty");
  }
  if (input.amountUsdMicros <= 0n) {
    throw new Error("createKonnectCreditGrant: amountUsdMicros must be positive");
  }

  const apiKey = resolveApiKey(input.apiKey);
  if (!apiKey) {
    throw new Error("createKonnectCreditGrant: OPENMETER_API_KEY is not configured");
  }

  const body: Record<string, unknown> = {
    name,
    funding_method: "none",
    currency: "USD",
    amount: usdMicrosToDecimalDollars(input.amountUsdMicros),
    priority: 1,
    expires_after: input.expiresAfter ?? "P1Y",
    key: idempotencyKey,
  };
  if (input.description?.trim()) {
    body.description = input.description.trim();
  }
  const featureKey = input.featureKey?.trim();
  if (featureKey) {
    body.filters = { features: [featureKey] };
  }

  const response = await konnectCreditsFetch(
    `/customers/${encodeURIComponent(customerId)}/credits/grants`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    apiKey,
  );

  if (response.status === 409) {
    return { created: false, conflict: true };
  }
  if (!response.ok) {
    throw new Error(
      `Konnect credits/grants create failed (${response.url}) [${response.status}]: ${await response.text()}`,
    );
  }
  return { created: true, conflict: false };
}
