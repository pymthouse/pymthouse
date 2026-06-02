import { db } from "@/db/index";
import {
  normalizeDiscoveryAllowlistDoc,
  resolveDiscoveryCapabilitiesForExclusions,
  type AppManifestResponse,
} from "@/lib/discovery-allowlist";
import {
  buildManifestWhenCatalogUnavailable,
  toAppManifestResponse,
} from "@/lib/discovery-allowlist-manifest";
import { fetchPipelineCatalog } from "@/lib/naap-catalog";
import {
  getOrCreateNetworkDefaultPlan,
  selectNetworkDefaultPlan,
  type DbExecutor,
} from "@/lib/network-default-plan";

/**
 * Resolve the app network capability manifest (catalog minus Network Price exclusions).
 * Used by GET/PUT `/manifest` and by the in-memory signer policy cache warmer.
 */
export async function buildAppManifestForApp(
  appInternalId: string,
  executor: DbExecutor = db,
): Promise<AppManifestResponse> {
  const row =
    (await selectNetworkDefaultPlan(appInternalId, executor)) ??
    (await getOrCreateNetworkDefaultPlan(appInternalId, executor));
  const excludedDoc = normalizeDiscoveryAllowlistDoc(
    row.discoveryExcludedCapabilities ?? null,
  );

  let catalog;
  try {
    catalog = await fetchPipelineCatalog();
  } catch {
    return buildManifestWhenCatalogUnavailable(excludedDoc);
  }

  const lite = catalog.map((e) => ({ id: e.id, models: e.models }));
  const resolved = resolveDiscoveryCapabilitiesForExclusions(lite, excludedDoc);
  return toAppManifestResponse(resolved);
}
