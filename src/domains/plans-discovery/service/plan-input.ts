import type { UpdatePlanInput, CreatePlanInput, PlanCapabilityInput } from "../types/plans";

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

function isNonNegativeIntegerString(s: string): boolean {
  return /^\d+$/.test(s);
}

function parseOptionalNonNegativeBps(raw: unknown, fieldName: string): Ok<number | null> | Err {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, error: `${fieldName} must be a non-negative integer (basis points)` };
  }
  return { ok: true, value: n };
}

function parseOptionalNonNegativeIntString(
  raw: unknown,
  fieldName: string,
): Ok<string | null> | Err {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  const s = String(raw).trim();
  if (s === "") {
    return { ok: true, value: null };
  }
  if (!isNonNegativeIntegerString(s)) {
    return { ok: false, error: `${fieldName} must be a non-negative integer string` };
  }
  return { ok: true, value: s };
}

function resolveBillingFieldsForPost(
  planType: string,
  body: Record<string, unknown>,
): Ok<{ includedUnits: string | null; overageRateWei: string | null }> | Err {
  if (planType === "free") {
    return { ok: true, value: { includedUnits: null, overageRateWei: null } };
  }
  if (planType === "subscription") {
    const inc = parseOptionalNonNegativeIntString(body.includedUnits, "includedUnits");
    const ovr = parseOptionalNonNegativeIntString(body.overageRateWei, "overageRateWei");
    if (!inc.ok) return inc;
    if (!ovr.ok) return ovr;
    if (inc.value === null || ovr.value === null) {
      return {
        ok: false,
        error: "includedUnits and overageRateWei are required for subscription plans",
      };
    }
    return { ok: true, value: { includedUnits: inc.value, overageRateWei: ovr.value } };
  }
  if (planType === "usage") {
    const inc = parseOptionalNonNegativeIntString(body.includedUnits, "includedUnits");
    const ovr = parseOptionalNonNegativeIntString(body.overageRateWei, "overageRateWei");
    if (!inc.ok) return inc;
    if (!ovr.ok) return ovr;
    return { ok: true, value: { includedUnits: inc.value, overageRateWei: ovr.value } };
  }
  return { ok: true, value: { includedUnits: null, overageRateWei: null } };
}

function mergeBillingFieldForPut(
  rawBody: unknown,
  existing: string | null,
  fieldName: string,
): Ok<string | null> | Err {
  if (rawBody === undefined) {
    if (existing === null || existing === undefined) {
      return { ok: true, value: null };
    }
    const t = String(existing).trim();
    if (t === "") {
      return { ok: true, value: null };
    }
    if (!isNonNegativeIntegerString(t)) {
      return { ok: false, error: `${fieldName} must be a non-negative integer string` };
    }
    return { ok: true, value: t };
  }
  return parseOptionalNonNegativeIntString(rawBody, fieldName);
}

function resolveBillingFieldsForPut(
  effectiveType: string,
  body: Record<string, unknown>,
  existing: { includedUnits: string | null; overageRateWei: string | null },
): Ok<{ includedUnits: string | null; overageRateWei: string | null }> | Err {
  if (effectiveType === "free") {
    return { ok: true, value: { includedUnits: null, overageRateWei: null } };
  }
  if (effectiveType === "subscription") {
    const inc = mergeBillingFieldForPut(body.includedUnits, existing.includedUnits, "includedUnits");
    const ovr = mergeBillingFieldForPut(body.overageRateWei, existing.overageRateWei, "overageRateWei");
    if (!inc.ok) return inc;
    if (!ovr.ok) return ovr;
    if (inc.value === null || ovr.value === null) {
      return {
        ok: false,
        error: "includedUnits and overageRateWei are required for subscription plans",
      };
    }
    return { ok: true, value: { includedUnits: inc.value, overageRateWei: ovr.value } };
  }
  if (effectiveType === "usage") {
    const inc = mergeBillingFieldForPut(body.includedUnits, existing.includedUnits, "includedUnits");
    const ovr = mergeBillingFieldForPut(body.overageRateWei, existing.overageRateWei, "overageRateWei");
    if (!inc.ok) return inc;
    if (!ovr.ok) return ovr;
    return { ok: true, value: { includedUnits: inc.value, overageRateWei: ovr.value } };
  }
  return { ok: true, value: { includedUnits: null, overageRateWei: null } };
}

function parseCapabilities(input: unknown): Ok<PlanCapabilityInput[]> | Err {
  if (input === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(input)) {
    return { ok: false, error: "capabilities must be an array" };
  }

  const capabilities = input.map((raw, index) => {
    const value = (raw ?? {}) as Record<string, unknown>;
    const pipeline = typeof value.pipeline === "string" ? value.pipeline.trim() : "";
    const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";

    if (!pipeline) {
      throw new Error(`capabilities[${index}].pipeline is required`);
    }
    if (!modelId) {
      throw new Error(`capabilities[${index}].modelId is required`);
    }

    const rawSlaTargetScore = value.slaTargetScore;
    const rawSlaTargetP95Ms = value.slaTargetP95Ms;
    const parsedSlaTargetScore =
      rawSlaTargetScore === null || rawSlaTargetScore === undefined
        ? null
        : Number(rawSlaTargetScore);
    const parsedSlaTargetP95Ms =
      rawSlaTargetP95Ms === null || rawSlaTargetP95Ms === undefined
        ? null
        : Number(rawSlaTargetP95Ms);

    if (parsedSlaTargetScore !== null && !Number.isFinite(parsedSlaTargetScore)) {
      throw new Error(`capabilities[${index}].slaTargetScore must be numeric`);
    }
    if (parsedSlaTargetP95Ms !== null && !Number.isFinite(parsedSlaTargetP95Ms)) {
      throw new Error(`capabilities[${index}].slaTargetP95Ms must be numeric`);
    }

    const rawUpcharge = value.upchargePercentBps;
    let parsedUpchargeBps: number | null = null;
    if (rawUpcharge !== null && rawUpcharge !== undefined) {
      const n = typeof rawUpcharge === "number" ? rawUpcharge : Number(String(rawUpcharge).trim());
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(
          `capabilities[${index}].upchargePercentBps must be a non-negative integer`,
        );
      }
      parsedUpchargeBps = n;
    }

    return {
      pipeline,
      modelId,
      slaTargetScore: parsedSlaTargetScore,
      slaTargetP95Ms: parsedSlaTargetP95Ms,
      maxPricePerUnit:
        value.maxPricePerUnit === null || value.maxPricePerUnit === undefined
          ? null
          : String(value.maxPricePerUnit),
      upchargePercentBps: parsedUpchargeBps,
    };
  });

  return { ok: true, value: capabilities };
}

function normalizeDiscoveryProfileId(raw: unknown): Ok<string | null | undefined> | Err {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (raw === null || raw === "") {
    return { ok: true, value: null };
  }
  if (typeof raw === "string" && raw.trim()) {
    return { ok: true, value: raw.trim() };
  }
  return { ok: false, error: "discoveryProfileId must be a non-empty string or null" };
}

function parseIncludedUsdMicrosForPost(raw: unknown): Ok<string | null> | Err {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  const s = String(raw).trim();
  if (s !== "" && !isNonNegativeIntegerString(s)) {
    return { ok: false, error: "includedUsdMicros must be a non-negative integer string" };
  }
  return { ok: true, value: s || null };
}

function parseIncludedUsdMicrosForPut(raw: unknown): Ok<string | null | undefined> | Err {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (raw === null) {
    return { ok: true, value: null };
  }
  const s = String(raw).trim();
  if (s !== "" && !isNonNegativeIntegerString(s)) {
    return { ok: false, error: "includedUsdMicros must be a non-negative integer string" };
  }
  return { ok: true, value: s || null };
}

export function parseCreatePlanInput(body: Record<string, unknown>): Ok<CreatePlanInput> | Err {
  const name = String(body.name || "").trim();
  if (!name) {
    return { ok: false, error: "name is required" };
  }

  let capabilities: PlanCapabilityInput[];
  try {
    const parsed = parseCapabilities(body.capabilities);
    if (!parsed.ok) return parsed;
    capabilities = parsed.value;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid capabilities" };
  }

  const discoveryProfileId = normalizeDiscoveryProfileId(body.discoveryProfileId);
  if (!discoveryProfileId.ok) return discoveryProfileId;

  const type = String(body.type || "free");
  const billing = resolveBillingFieldsForPost(type, body);
  if (!billing.ok) return billing;

  const generalUpcharge = parseOptionalNonNegativeBps(
    body.generalUpchargePercentBps,
    "generalUpchargePercentBps",
  );
  if (!generalUpcharge.ok) return generalUpcharge;
  const payPerUseUpcharge = parseOptionalNonNegativeBps(
    body.payPerUseUpchargePercentBps,
    "payPerUseUpchargePercentBps",
  );
  if (!payPerUseUpcharge.ok) return payPerUseUpcharge;
  const includedUsdMicros = parseIncludedUsdMicrosForPost(body.includedUsdMicros);
  if (!includedUsdMicros.ok) return includedUsdMicros;

  return {
    ok: true,
    value: {
      name,
      type,
      priceAmount: String(body.priceAmount || "0"),
      priceCurrency: String(body.priceCurrency || "USD"),
      status: String(body.status || "active"),
      includedUnits: billing.value.includedUnits,
      overageRateWei: billing.value.overageRateWei,
      includedUsdMicros: includedUsdMicros.value,
      generalUpchargePercentBps: generalUpcharge.value,
      payPerUseUpchargePercentBps: payPerUseUpcharge.value,
      billingCycle: typeof body.billingCycle === "string" ? body.billingCycle : "monthly",
      discoveryProfileId: discoveryProfileId.value ?? null,
      capabilities,
    },
  };
}

export function parseUpdatePlanInput(
  body: Record<string, unknown>,
  existing: { type: string; includedUnits: string | null; overageRateWei: string | null },
): Ok<UpdatePlanInput> | Err {
  if (!body || typeof body.id !== "string" || !body.id.trim()) {
    return { ok: false, error: "id is required and must be a string" };
  }

  const discoveryProfileId = normalizeDiscoveryProfileId(body.discoveryProfileId);
  if (!discoveryProfileId.ok) return discoveryProfileId;

  let capabilities: PlanCapabilityInput[] | undefined;
  if (body.capabilities !== undefined) {
    try {
      const parsed = parseCapabilities(body.capabilities);
      if (!parsed.ok) return parsed;
      capabilities = parsed.value;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Invalid capabilities" };
    }
  }

  const nextType = body.type !== undefined ? String(body.type) : existing.type;
  const billing = resolveBillingFieldsForPut(nextType, body, existing);
  if (!billing.ok) return billing;

  const generalUpcharge = parseOptionalNonNegativeBps(
    body.generalUpchargePercentBps,
    "generalUpchargePercentBps",
  );
  if (!generalUpcharge.ok) return generalUpcharge;
  const payPerUseUpcharge = parseOptionalNonNegativeBps(
    body.payPerUseUpchargePercentBps,
    "payPerUseUpchargePercentBps",
  );
  if (!payPerUseUpcharge.ok) return payPerUseUpcharge;
  const includedUsdMicros = parseIncludedUsdMicrosForPut(body.includedUsdMicros);
  if (!includedUsdMicros.ok) return includedUsdMicros;

  const value: UpdatePlanInput = {
    id: String(body.id),
    type: nextType,
    includedUnits: billing.value.includedUnits,
    overageRateWei: billing.value.overageRateWei,
  };

  if (body.name !== undefined) value.name = String(body.name);
  if (body.priceAmount !== undefined) value.priceAmount = String(body.priceAmount);
  if (body.priceCurrency !== undefined) value.priceCurrency = String(body.priceCurrency);
  if (body.status !== undefined) value.status = String(body.status);
  if (body.generalUpchargePercentBps !== undefined) {
    value.generalUpchargePercentBps = generalUpcharge.value;
  }
  if (body.payPerUseUpchargePercentBps !== undefined) {
    value.payPerUseUpchargePercentBps = payPerUseUpcharge.value;
  }
  if (includedUsdMicros.value !== undefined) {
    value.includedUsdMicros = includedUsdMicros.value;
  }
  if (body.billingCycle !== undefined) value.billingCycle = String(body.billingCycle);
  if (discoveryProfileId.value !== undefined) value.discoveryProfileId = discoveryProfileId.value;
  if (capabilities !== undefined) value.capabilities = capabilities;

  return { ok: true, value };
}
