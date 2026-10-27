import type { HomeApp } from "@/components/AppCard";
import {
  listPopularPublishedHomeAppIds,
  listPublishedHomeApps,
} from "../repo/home";

type PublishedAppRow = HomeApp & { featured: boolean };

function toHomeApp(row: PublishedAppRow): HomeApp {
  return {
    id: row.id,
    name: row.name,
    subtitle: row.subtitle,
    description: row.description,
    category: row.category,
    developerName: row.developerName,
  };
}

export async function getHomeShowcaseData() {
  const rows = await listPublishedHomeApps();
  const mapped: PublishedAppRow[] = rows
    .filter((r): r is typeof r & { id: string } => Boolean(r.id))
    .map((r) => ({
      id: r.id,
      name: r.name,
      subtitle: r.subtitle,
      description: r.description,
      category: r.category,
      developerName: r.developerName,
      featured: r.marketplaceFeatured === 1,
    }));

  const featuredApps = mapped.filter((a) => a.featured).slice(0, 4).map(toHomeApp);

  if (featuredApps.length > 0) {
    return {
      showcaseApps: featuredApps,
      showcaseTitle: "Featured apps",
    };
  }

  if (mapped.length === 0) {
    return {
      showcaseApps: [] as HomeApp[],
      showcaseTitle: "Featured apps",
    };
  }

  const rankRows = await listPopularPublishedHomeAppIds(4);
  const byId = new Map(mapped.map((m) => [m.id, toHomeApp(m)]));
  let showcaseApps = rankRows
    .map((r) => byId.get(r.id))
    .filter((a): a is HomeApp => a !== undefined);
  if (showcaseApps.length === 0) {
    showcaseApps = mapped.slice(0, 4).map(toHomeApp);
  }

  return {
    showcaseApps,
    showcaseTitle: "Popular apps",
  };
}
