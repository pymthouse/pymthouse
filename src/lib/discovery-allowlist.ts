import { z } from "zod";

export const DiscoveryAllowlistCapabilitySchema = z
  .object({
    pipeline: z.string().min(1).max(256),
    modelId: z.string().min(1).max(256),
  })
  .strict();

export const DiscoveryAllowlistUpdateBodySchema = z
  .object({
    excludedCapabilities: z.array(DiscoveryAllowlistCapabilitySchema).max(2000),
  })
  .strict();

export type DiscoveryAllowlistCapability = z.infer<typeof DiscoveryAllowlistCapabilitySchema>;
export type DiscoveryAllowlistUpdatePayload = z.infer<typeof DiscoveryAllowlistUpdateBodySchema>;

export type DiscoveryAllowlistDocument = {
  capabilities: DiscoveryAllowlistCapability[];
};

/** Minimal catalog shape for resolution (matches NaaP pipeline catalog entries). */
export type PipelineCatalogEntryLite = {
  id: string;
  models: string[];
};

export function normalizeDiscoveryAllowlistDoc(
  raw: unknown,
): DiscoveryAllowlistDocument | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const caps = (raw as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(caps)) return null;
  const out: DiscoveryAllowlistCapability[] = [];
  for (const c of caps) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const pipeline = (c as { pipeline?: unknown }).pipeline;
    const modelId = (c as { modelId?: unknown }).modelId;
    if (typeof pipeline !== "string" || typeof modelId !== "string") continue;
    if (!pipeline.trim() || !modelId.trim()) continue;
    out.push({ pipeline: pipeline.trim(), modelId: modelId.trim() });
  }
  return { capabilities: out };
}

export function isDiscoveryDocumentEmpty(
  doc: DiscoveryAllowlistDocument | null | undefined,
): boolean {
  return !doc?.capabilities?.length;
}

function concreteKeysForPipeline(
  catalog: PipelineCatalogEntryLite[],
  pipelineId: string,
): Set<string> {
  const e = catalog.find((c) => c.id === pipelineId);
  if (!e) return new Set();
  return new Set(e.models.map((m) => `${pipelineId}|${m}`));
}

export function expandDocumentToConcreteKeys(
  doc: DiscoveryAllowlistDocument,
  catalog: PipelineCatalogEntryLite[],
): Set<string> {
  const out = new Set<string>();
  for (const { pipeline, modelId } of doc.capabilities) {
    if (modelId === "*") {
      for (const k of concreteKeysForPipeline(catalog, pipeline)) {
        out.add(k);
      }
    } else {
      const e = catalog.find((c) => c.id === pipeline);
      if (e?.models.includes(modelId)) {
        out.add(`${pipeline}|${modelId}`);
      }
    }
  }
  return out;
}

export function fullCatalogConcreteKeys(
  catalog: PipelineCatalogEntryLite[],
): Set<string> {
  const out = new Set<string>();
  for (const e of catalog) {
    for (const m of e.models) {
      out.add(`${e.id}|${m}`);
    }
  }
  return out;
}

function sortCap(
  a: DiscoveryAllowlistCapability,
  b: DiscoveryAllowlistCapability,
): number {
  const p = a.pipeline.localeCompare(b.pipeline);
  return p !== 0 ? p : a.modelId.localeCompare(b.modelId);
}

/**
 * Resolve network-default exclusions against the live catalog into the explicit
 * capability list NaaP intersects on (full catalog minus exclusions).
 */
export function resolveDiscoveryCapabilitiesForExclusions(
  catalog: PipelineCatalogEntryLite[],
  excluded: DiscoveryAllowlistDocument | null,
): {
  capabilities: DiscoveryAllowlistCapability[];
  excludedCapabilities: DiscoveryAllowlistCapability[];
} {
  const excludedArr = excluded?.capabilities ?? [];
  const all = fullCatalogConcreteKeys(catalog);
  if (isDiscoveryDocumentEmpty(excluded)) {
    const capabilities = [...all]
      .map((k) => {
        const sep = k.indexOf("|");
        return { pipeline: k.slice(0, sep), modelId: k.slice(sep + 1) };
      })
      .sort(sortCap);
    return {
      capabilities,
      excludedCapabilities: [],
    };
  }
  const excl = expandDocumentToConcreteKeys(excluded!, catalog);
  const resolvedKeys = [...all].filter((k) => !excl.has(k));
  const capabilities = resolvedKeys
    .map((k) => {
      const sep = k.indexOf("|");
      return { pipeline: k.slice(0, sep), modelId: k.slice(sep + 1) };
    })
    .sort(sortCap);
  return {
    capabilities,
    excludedCapabilities: [...excludedArr].sort(sortCap),
  };
}

/** Picker `values` (pipeline wildcard and/or pipeline|model) when exclusions are stored in DB. */
export function pickerValuesFromExcludedDocument(
  catalog: PipelineCatalogEntryLite[],
  excluded: DiscoveryAllowlistDocument | null,
): string[] {
  if (!catalog.length) return [];
  if (isDiscoveryDocumentEmpty(excluded)) {
    return catalog.map((e) => e.id);
  }
  const excludedConcrete = expandDocumentToConcreteKeys(excluded!, catalog);
  const out: string[] = [];
  for (const e of catalog) {
    const modelsExcluded = e.models.filter((m) =>
      excludedConcrete.has(`${e.id}|${m}`),
    );
    if (modelsExcluded.length === 0) {
      out.push(e.id);
      continue;
    }
    if (modelsExcluded.length === e.models.length) {
      continue;
    }
    for (const m of e.models) {
      if (!excludedConcrete.has(`${e.id}|${m}`)) {
        out.push(`${e.id}|${m}`);
      }
    }
  }
  return out;
}

/** Convert picker selection into minimal exclusion rows for persistence. */
export function excludedDocumentFromPickerValues(
  catalog: PipelineCatalogEntryLite[],
  values: string[],
): DiscoveryAllowlistCapability[] {
  const wild = new Set(values.filter((v) => !v.includes("|")));
  const indiv = new Set(values.filter((v) => v.includes("|")));
  const includedConcrete = new Set<string>();
  for (const e of catalog) {
    if (wild.has(e.id)) {
      for (const m of e.models) {
        includedConcrete.add(`${e.id}|${m}`);
      }
    } else {
      for (const m of e.models) {
        if (indiv.has(`${e.id}|${m}`)) {
          includedConcrete.add(`${e.id}|${m}`);
        }
      }
    }
  }
  const all = fullCatalogConcreteKeys(catalog);
  const excludedKeys = [...all].filter((k) => !includedConcrete.has(k));
  const out: DiscoveryAllowlistCapability[] = [];
  for (const e of catalog) {
    const exModels = excludedKeys
      .filter((k) => k.startsWith(`${e.id}|`))
      .map((k) => k.slice(e.id.length + 1));
    if (exModels.length === 0) continue;
    if (exModels.length === e.models.length) {
      out.push({ pipeline: e.id, modelId: "*" });
    } else {
      for (const m of exModels) {
        out.push({ pipeline: e.id, modelId: m });
      }
    }
  }
  return out.sort(sortCap);
}
