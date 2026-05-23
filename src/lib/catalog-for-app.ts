import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { developerApps } from "@/db/schema";
import {
  fetchPipelineCatalog,
  filterCatalogByServiceType,
  type PipelineCatalogEntry,
} from "@/lib/naap-catalog";
import type { DbExecutor } from "@/lib/network-default-plan";
import {
  catalogServiceTypesForSigningMode,
  type CatalogServiceType,
} from "@/lib/signing-modes";

export function catalogForServiceTypes(
  fullCatalog: PipelineCatalogEntry[],
  serviceTypes: CatalogServiceType[],
): PipelineCatalogEntry[] {
  if (serviceTypes.length === 0) {
    return [...fullCatalog];
  }

  if (serviceTypes.length === 1) {
    const [only] = serviceTypes;
    return only ? filterCatalogByServiceType(fullCatalog, only) : [...fullCatalog];
  }

  const allowed = new Set<CatalogServiceType>(serviceTypes);
  const byId = new Map<string, PipelineCatalogEntry>();
  for (const entry of fullCatalog) {
    if (!entry.serviceType || !allowed.has(entry.serviceType)) {
      continue;
    }

    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, {
        ...entry,
        models: [...entry.models].sort((a, b) => a.localeCompare(b)),
      });
      continue;
    }

    const mergedModels = new Set<string>(existing.models);
    for (const model of entry.models) {
      mergedModels.add(model);
    }
    byId.set(entry.id, {
      ...existing,
      // When both service types exist for one pipeline, prefer registry label.
      serviceType:
        existing.serviceType === "registry" || entry.serviceType === "registry"
          ? "registry"
          : "legacy",
      models: [...mergedModels].sort((a, b) => a.localeCompare(b)),
    });
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function resolveCatalogServiceTypesForApp(
  appInternalId: string,
  executor: DbExecutor = db,
): Promise<CatalogServiceType[]> {
  const rows = await executor
    .select({ signingMode: developerApps.signingMode })
    .from(developerApps)
    .where(eq(developerApps.id, appInternalId))
    .limit(1);
  return catalogServiceTypesForSigningMode(rows[0]?.signingMode);
}

export async function fetchPipelineCatalogForApp(
  appInternalId: string,
  executor: DbExecutor = db,
): Promise<PipelineCatalogEntry[]> {
  const serviceTypes = await resolveCatalogServiceTypesForApp(
    appInternalId,
    executor,
  );
  const full = await fetchPipelineCatalog();
  return catalogForServiceTypes(full, serviceTypes);
}

/** Primary catalog scope label for UI (dual → `dual`). */
export async function resolveCatalogServiceTypeForApp(
  appInternalId: string,
  executor: DbExecutor = db,
): Promise<CatalogServiceType | "dual"> {
  const types = await resolveCatalogServiceTypesForApp(appInternalId, executor);
  if (types.length >= 2) return "dual";
  return types[0] ?? "legacy";
}
