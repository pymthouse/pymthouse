import { usdCentsDisplayToMicros } from "@/lib/format-usd-micros";

export type OwnerOverrideFormFields = {
  starterDisplay: string;
  endUserCap: string;
  note: string;
  clearStarter?: boolean;
};

export type OwnerOverridePatchBuildResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string };

/** Build the admin owner-override PATCH body from form fields. */
export function buildOwnerOverridePatchBody(
  fields: OwnerOverrideFormFields,
): OwnerOverridePatchBuildResult {
  const body: Record<string, unknown> = {};

  if (fields.clearStarter || !fields.starterDisplay.trim()) {
    body.starterIncludedUsdMicros = null;
  } else {
    const micros = usdCentsDisplayToMicros(fields.starterDisplay);
    if (!micros) {
      return {
        ok: false,
        error: "Enter a valid USD starter allowance or clear the field",
      };
    }
    body.starterIncludedUsdMicros = micros;
  }

  if (fields.endUserCap.trim()) {
    const parsed = Number.parseInt(fields.endUserCap, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { ok: false, error: "End-user cap must be a positive integer" };
    }
    body.endUserCap = parsed;
  } else {
    body.endUserCap = null;
  }

  body.note = fields.note.trim() || null;
  return { ok: true, body };
}
