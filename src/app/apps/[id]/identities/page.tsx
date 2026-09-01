export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";

import AppSectionBreadcrumb from "@/components/apps/AppSectionBreadcrumb";
import BillingCyclePicker from "@/components/billing/BillingCyclePicker";
import IdentitiesTable from "@/components/identities/IdentitiesTable";
import { BILLING_CYCLE_PARAM, resolveBillingCycle } from "@/lib/billing-utils";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import { getAuthorizedProviderApp } from "@/lib/provider-apps";
import { listAppIdentities } from "@/lib/usage/identity-rollup";

export default async function AppIdentitiesPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cycle?: string }>;
}>) {
  const { id } = await params;
  const query = await searchParams;
  const selectedCycle = resolveBillingCycle(query.cycle);

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
  const cycle = { start: selectedCycle.start, end: selectedCycle.end };
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
            selected cycle. Open an identity to manage its account, subscription, and
            discounts — only active identities count toward the end-user cap.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
          <BillingCyclePicker />
          <Link
            href={`/apps/${id}/usage${
              selectedCycle.isCurrent ? "" : `?${BILLING_CYCLE_PARAM}=${selectedCycle.key}`
            }`}
            className="text-sm text-emerald-400 transition-colors hover:text-emerald-300"
          >
            View app usage →
          </Link>
        </div>
      </div>

      {openMeterConfigured ? (
        <IdentitiesTable
          appId={id}
          identities={identities}
          cycleKey={selectedCycle.isCurrent ? null : selectedCycle.key}
        />
      ) : (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-5 text-sm text-zinc-500">
          Usage metering is not configured, so per-identity usage is unavailable.
        </div>
      )}
    </>
  );
}
