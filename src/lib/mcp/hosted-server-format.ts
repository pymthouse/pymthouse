function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function projectOrchestrator(row: unknown): Record<string, unknown> {
  const rec = asRecord(row);
  if (!rec) return { value: row };
  const projected: Record<string, unknown> = {};
  for (const key of ["id", "avail", "price", "capabilities"]) {
    if (key in rec) projected[key] = rec[key];
  }
  return Object.keys(projected).length > 0 ? projected : rec;
}

export function projectDiscoveryQueryResult(data: unknown): {
  orchestrators: Record<string, unknown>[];
  total_count: number;
} {
  const rec = asRecord(data);
  const list = Array.isArray(data)
    ? data
    : rec && Array.isArray(rec.results)
      ? rec.results
      : rec && Array.isArray(rec.orchestrators)
        ? rec.orchestrators
        : [];
  const reported =
    rec && typeof rec.total_count === "number"
      ? rec.total_count
      : rec && typeof rec.totalCount === "number"
        ? rec.totalCount
        : list.length;
  return {
    orchestrators: list.map(projectOrchestrator),
    total_count: reported,
  };
}
