import type { PipelineCatalogEntry } from "@/lib/naap-catalog";
import { setFetchPipelineCatalogForTests } from "@/lib/naap-catalog";

export function installNaapCatalogMock(options: {
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

export function uninstallNaapCatalogMock(): void {
  setFetchPipelineCatalogForTests(null);
}
