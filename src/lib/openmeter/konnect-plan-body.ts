/** Convert SDK camelCase keys to Konnect snake_case (recursive). */
import { usdMicrosToNanos } from "./constants";

export function camelToSnakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function deepCamelToSnake(value: unknown, visited = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    if (visited.has(value)) {
      return null;
    }
    visited.add(value);
    return value.map((item) => deepCamelToSnake(item, visited));
  }
  if (value && typeof value === "object") {
    if (visited.has(value)) {
      return null;
    }
    visited.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (nested === undefined) {
        continue;
      }
      out[camelToSnakeKey(key)] = deepCamelToSnake(nested, visited);
    }
    return out;
  }
  return value;
}

function normalizeKonnectPlanPhases(phases: unknown): unknown {
  if (!Array.isArray(phases)) {
    return phases;
  }

  return phases.map((phase) => {
    if (!phase || typeof phase !== "object") {
      return phase;
    }
    const record = { ...(phase as Record<string, unknown>) };
    if (record.duration === null) {
      delete record.duration;
    }

    const rateCards = record.rate_cards;
    if (Array.isArray(rateCards)) {
      record.rate_cards = rateCards.map((card) => {
        if (!card || typeof card !== "object") {
          return card;
        }
        const rateCard = { ...(card as Record<string, unknown>) };
        delete rateCard.type;
        delete rateCard.entitlement_template;

        if (
          rateCard.feature == null &&
          typeof rateCard.feature_key === "string" &&
          rateCard.feature_key.trim()
        ) {
          rateCard.feature = { key: rateCard.feature_key.trim() };
          delete rateCard.feature_key;
        }

        if (rateCard.price && typeof rateCard.price === "object") {
          const price = { ...(rateCard.price as Record<string, unknown>) };
          if (price.payment_term == null && price.paymentTerm != null) {
            price.payment_term = price.paymentTerm;
            delete price.paymentTerm;
          }
          rateCard.price = price;
        }

        return rateCard;
      });
    }

    return record;
  });
}

/** Normalize SDK plan create/update bodies for Konnect Metering & Billing v3. */
export function rewriteKonnectPlanRequestBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null) {
    return body;
  }

  const snake = deepCamelToSnake(body) as Record<string, unknown>;
  if (Array.isArray(snake.phases)) {
    snake.phases = normalizeKonnectPlanPhases(snake.phases);
  }
  return snake;
}

export function buildKonnectUsageRateCard(input: {
  key: string;
  name: string;
  featureId: string;
  unitAmount: string;
  billingCadence?: string;
  /** Free usage units (USD micros in app; converted to meter nanos below). */
  includedMicros?: number;
}): Record<string, unknown> {
  const card: Record<string, unknown> = {
    key: input.key,
    name: input.name,
    feature: { id: input.featureId },
    billing_cadence: input.billingCadence ?? "P1M",
    price: {
      type: "unit",
      amount: input.unitAmount,
    },
  };

  if (input.includedMicros != null && input.includedMicros > 0) {
    card.discounts = {
      usage: String(usdMicrosToNanos(BigInt(input.includedMicros))),
    };
  }

  return card;
}

export function buildKonnectFlatFeeRateCard(input: {
  key: string;
  name: string;
  amount: string;
  billingCadence?: string;
  paymentTerm?: "in_advance" | "in_arrears";
}): Record<string, unknown> {
  return {
    key: input.key,
    name: input.name,
    billing_cadence: input.billingCadence ?? "P1M",
    payment_term: input.paymentTerm ?? "in_advance",
    price: {
      type: "flat",
      amount: input.amount,
    },
  };
}
