import { redirect } from "next/navigation";
import {
  appSettingsPath,
  normalizeAppSettingsTab,
} from "@/lib/apps/settings-paths";

/**
 * Legacy `/apps/[id]/settings?tab=` → path-based `/apps/[id]` or `/apps/[id]/{tab}`.
 */
export default async function AppSettingsRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const tabRaw = typeof sp.tab === "string" ? sp.tab : undefined;
  const tab = normalizeAppSettingsTab(tabRaw);
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (key === "tab" || value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) next.append(key, v);
    } else {
      next.set(key, value);
    }
  }
  const qs = next.toString();
  const path = appSettingsPath(id, tab);
  redirect(qs ? `${path}?${qs}` : path);
}
