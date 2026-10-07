import {
  getPublishedMarketplaceAppByAppId,
  getPublishedMarketplaceAppByClientId,
  listPublishedMarketplaceApps,
} from "../repo/public-marketplace";

export function shapePublicMarketplaceApp<T extends {
  marketplaceFeatured: number | null;
  webOidcClientId: string | null;
}>(row: T) {
  const { marketplaceFeatured, webOidcClientId, ...app } = row;
  return {
    ...app,
    clientId: webOidcClientId,
    featured: marketplaceFeatured === 1,
  };
}

export async function getPublicMarketplaceApps() {
  const rows = await listPublishedMarketplaceApps();
  return rows.map(shapePublicMarketplaceApp);
}

export async function getPublicMarketplaceApp(routeId: string) {
  const byAppId = await getPublishedMarketplaceAppByAppId(routeId);
  const row = byAppId[0] ?? (await getPublishedMarketplaceAppByClientId(routeId))[0];
  return row ? shapePublicMarketplaceApp(row) : null;
}
