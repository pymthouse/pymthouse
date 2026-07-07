export function scopeStringFromPayload(payload: Record<string, unknown>): string {
  const scopeFromScope =
    typeof payload.scope === "string" ? payload.scope.trim() : "";
  if (scopeFromScope) {
    return scopeFromScope.replace(/\s+/g, " ").trim();
  }
  const scpRaw = payload.scp;
  if (Array.isArray(scpRaw)) {
    return scpRaw.filter((v): v is string => typeof v === "string").join(" ");
  }
  if (typeof scpRaw === "string") {
    return scpRaw.trim();
  }
  return "sign:job";
}
