export function pickConflictingStringAliases(
  body: Record<string, unknown>,
  ...keys: string[]
):
  | { ok: true; value: string | undefined }
  | { ok: false; message: string } {
  const values = keys
    .map((key) => {
      const raw = body[key];
      const defined = raw !== undefined && raw !== null && `${raw}`.length > 0;
      return defined ? { key, value: String(raw) } : null;
    })
    .filter((entry): entry is { key: string; value: string } => entry !== null);
  const first = values[0];
  const conflict = values.find((entry) => entry.value !== first?.value);
  if (first && conflict) {
    return {
      ok: false,
      message: `Conflicting ${keys.join("/")} in request body`,
    };
  }
  return { ok: true, value: first?.value };
}

export function pickConflictingNumberAliases(
  body: Record<string, unknown>,
  ...keys: string[]
):
  | { ok: true; value: number | undefined }
  | { ok: false; message: string } {
  const parseNum = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  };
  const values = keys
    .map((key) => {
      const value = parseNum(body[key]);
      return value !== undefined ? { key, value } : null;
    })
    .filter((entry): entry is { key: string; value: number } => entry !== null);
  const first = values[0];
  const conflict = values.find((entry) => entry.value !== first?.value);
  if (first && conflict) {
    return {
      ok: false,
      message: `Conflicting ${keys.join("/")} in request body`,
    };
  }
  return { ok: true, value: first?.value };
}

export function parseSignerPaymentRequest(requestBody: Record<string, unknown>) {
  const manifestPick = pickConflictingStringAliases(
    requestBody,
    "manifestId",
    "ManifestID",
    "manifestID",
  );
  if (!manifestPick.ok) return manifestPick;

  const inPixelsPick = pickConflictingNumberAliases(requestBody, "inPixels", "InPixels");
  if (!inPixelsPick.ok) return inPixelsPick;

  const preloadSecondsPick = pickConflictingNumberAliases(
    requestBody,
    "preloadSeconds",
    "PreloadSeconds",
  );
  if (!preloadSecondsPick.ok) return preloadSecondsPick;

  const jobTypePick = pickConflictingStringAliases(requestBody, "type", "Type");
  if (!jobTypePick.ok) return jobTypePick;

  const orchPick = pickConflictingStringAliases(requestBody, "orchestrator", "Orchestrator");
  if (!orchPick.ok) return orchPick;

  return {
    ok: true as const,
    value: {
      manifestId: manifestPick.value,
      inPixels: inPixelsPick.value,
      preloadSeconds: preloadSecondsPick.value,
      jobType: jobTypePick.value,
      orchestratorData: orchPick.value,
    },
  };
}
