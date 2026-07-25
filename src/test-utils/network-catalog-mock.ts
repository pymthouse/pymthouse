import type { PipelineCatalogEntry } from "@/lib/network-catalog";
import { setFetchPipelineCatalogForTests } from "@/lib/network-catalog";

export function installNetworkCatalogMock(options: {
  catalog: PipelineCatalogEntry[];
  onFetch?: () => void;
  shouldThrow?: () => boolean;
}): void {
  setFetchPipelineCatalogForTests(async () => {
    options.onFetch?.();
    if (options.shouldThrow?.()) {
      throw new Error("catalog unavailable");
    }
    return options.catalog;
  });
}

export function uninstallNetworkCatalogMock(): void {
  setFetchPipelineCatalogForTests(null);
}
