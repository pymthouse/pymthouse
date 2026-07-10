import { resolveHostedOpenMeterBaseUrl } from "./route-mode";

const USD_MICROS_PER_DOLLAR = 1_000_000n;

/** Convert integer USD micros to a Konnect credit amount string (USD). */
export function usdMicrosToUsdAmount(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / USD_MICROS_PER_DOLLAR;
  const frac = abs % USD_MICROS_PER_DOLLAR;
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  const body = fracStr ? `${whole}.${fracStr}` : whole.toString();
  return negative ? `-${body}` : body;
}

export function usdAmountToUsdMicros(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid USD amount: ${amount}`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart, fracPart = ""] = unsigned.split(".");
  const frac = `${fracPart}000000`.slice(0, 6);
  const micros = BigInt(wholePart || "0") * USD_MICROS_PER_DOLLAR + BigInt(frac || "0");
  return negative ? -micros : micros;
}

export async function createKonnectCreditGrant(input: {
  customerId: string;
  amountUsdMicros: bigint;
  name: string;
  idempotencyKey: string;
  apiKey?: string;
  expiresAfter?: string;
  priority?: number;
}): Promise<{ id: string; amount: string; currency: string }> {
  const customerId = input.customerId.trim();
  const apiKey = input.apiKey?.trim() || process.env.OPENMETER_API_KEY?.trim();
  if (!customerId) {
    throw new Error("createKonnectCreditGrant: customerId is required");
  }
  if (!apiKey) {
    throw new Error("createKonnectCreditGrant: OPENMETER_API_KEY is required");
  }
  if (input.amountUsdMicros <= 0n) {
    throw new Error("createKonnectCreditGrant: amount must be positive");
  }

  const baseUrl = resolveHostedOpenMeterBaseUrl(apiKey);
  const body = {
    name: input.name.trim() || "pymthouse credit grant",
    funding_method: "none",
    currency: "USD",
    amount: usdMicrosToUsdAmount(input.amountUsdMicros),
    priority: input.priority ?? 1,
    expires_after: input.expiresAfter ?? "P1Y",
    key: input.idempotencyKey.trim(),
  };

  const response = await fetch(
    `${baseUrl}/customers/${encodeURIComponent(customerId)}/credits/grants`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (response.status === 409) {
    // Idempotent retry — grant already exists for this key.
    return {
      id: input.idempotencyKey,
      amount: body.amount,
      currency: "USD",
    };
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `Konnect credit grant failed (${response.url}) [${response.status}]: ${raw}`,
    );
  }

  const parsed = JSON.parse(raw) as { id?: string; amount?: string; currency?: string };
  if (!parsed.id) {
    throw new Error("Konnect credit grant response missing id");
  }
  return {
    id: parsed.id,
    amount: parsed.amount ?? body.amount,
    currency: parsed.currency ?? "USD",
  };
}

export async function getKonnectCreditBalanceUsdMicros(input: {
  customerId: string;
  apiKey?: string;
  currency?: string;
}): Promise<bigint | null> {
  const customerId = input.customerId.trim();
  const apiKey = input.apiKey?.trim() || process.env.OPENMETER_API_KEY?.trim();
  if (!customerId || !apiKey) {
    return null;
  }

  const baseUrl = resolveHostedOpenMeterBaseUrl(apiKey);
  const response = await fetch(
    `${baseUrl}/customers/${encodeURIComponent(customerId)}/credits/balance`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    },
  );
  if (response.status === 404) {
    return 0n;
  }
  if (!response.ok) {
    throw new Error(
      `Konnect credit balance failed (${response.url}) [${response.status}]: ${await response.text()}`,
    );
  }

  const body = (await response.json()) as {
    balances?: Array<{ currency?: string; settled?: string; live?: string }>;
  };
  const currency = (input.currency || "USD").toUpperCase();
  const row = (body.balances ?? []).find(
    (item) => (item.currency || "").toUpperCase() === currency,
  );
  if (!row) {
    return 0n;
  }
  const amount = row.live ?? row.settled ?? "0";
  return usdAmountToUsdMicros(amount);
}
