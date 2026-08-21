export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";

import AppSectionBreadcrumb from "@/components/apps/AppSectionBreadcrumb";
import IdentitiesTable from "@/components/identities/IdentitiesTable";
import { calendarMonthBoundsUtc } from "@/lib/billing-utils";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import { getAuthorizedProviderApp } from "@/lib/provider-apps";
import { listAppIdentities } from "@/lib/usage/identity-rollup";

export default async function AppIdentitiesPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;

  let providerAuth: Awaited<ReturnType<typeof getAuthorizedProviderApp>> | null = null;
  try {
    providerAuth = await getAuthorizedProviderApp(id);
  } catch (err) {
    console.warn(
      "app-identities: auth resolution failed",
      id,
      err instanceof Error ? err.message : String(err),
    );
    providerAuth = null;
  }
  if (!providerAuth) {
    notFound();
  }

  const app = providerAuth.app;
  const cycle = calendarMonthBoundsUtc(new Date());
  const openMeterConfigured = requireOpenMeterForUsageReads();
  const identities = openMeterConfigured
    ? await listAppIdentities({
        clientId: app.id,
        startDate: cycle.start,
        endDate: cycle.end,
      }).catch((err) => {
        console.warn(
          "app-identities: listAppIdentities failed",
          app.id,
          err instanceof Error ? err.message : String(err),
        );
        return [];
      })
    : [];

  return (
    <>
      <AppSectionBreadcrumb appId={id} appName={app.name} section="Identities" />

      <div className="mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-zinc-100 sm:text-2xl">Identities</h1>
          <p className="mt-1 text-xs text-zinc-500 sm:text-sm">
            Every M2M identity billed under this app, sorted by network fee for the
            current cycle. Open an identity to deactivate or reactivate it — only
            active identities count toward the end-user cap.
          </p>
        </div>
        <Link
          href={`/apps/${id}/usage`}
          className="shrink-0 text-sm text-emerald-400 transition-colors hover:text-emerald-300"
        >
          View app usage →
        </Link>
      </div>

      {openMeterConfigured ? (
        <IdentitiesTable appId={id} identities={identities} />
      ) : (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-5 text-sm text-zinc-500">
          Usage metering is not configured, so per-identity usage is unavailable.
        </div>
      )}
    </>
  );
}
