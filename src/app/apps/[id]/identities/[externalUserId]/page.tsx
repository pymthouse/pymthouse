export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";

import AppSectionBreadcrumb from "@/components/apps/AppSectionBreadcrumb";
import DashboardLayout from "@/components/DashboardLayout";
import IdentityRequestLog from "@/components/identities/IdentityRequestLog";
import UsageBreakdownChart from "@/components/UsageBreakdownChart";
import { formatBillableDuration } from "@/lib/billing-format";
import { calendarMonthBoundsUtc, dateKeysInclusiveUtc } from "@/lib/billing-utils";
import {
  formatUsageJobTypeLabel,
  type BillingChartSeries,
} from "@/lib/billing-usage-dashboard-data";
import { formatUsdMicrosString } from "@/lib/format-usd-micros";
import { requireOpenMeterForUsageReads } from "@/lib/openmeter/constants";
import { getAuthorizedProviderApp } from "@/lib/provider-apps";
import { listAppIdentities } from "@/lib/usage/identity-rollup";
import { queryOpenMeterUserDailyByPipeline } from "@/lib/usage/query-openmeter";

/** Daily per-pipeline rows → one chart series per pipeline/model for this identity. */
function buildIdentitySeries(
  rows: Awaited<ReturnType<typeof queryOpenMeterUserDailyByPipeline>>,
  dateKeys: string[],
  appName: string,
  appId: string,
): BillingChartSeries[] {
  const dayCountsByKey = new Map<string, Map<string, number>>();
  const metaByKey = new Map<string, string>();

  for (const row of rows) {
    const pipeline = row.pipeline || "unknown";
    const modelId = row.modelId || "unknown";
    const key = `${pipeline}|${modelId}`;
    metaByKey.set(key, formatUsageJobTypeLabel(pipeline, modelId));
    const dayMap = dayCountsByKey.get(key) ?? new Map<string, number>();
    dayMap.set(row.date, (dayMap.get(row.date) ?? 0) + row.requestCount);
    dayCountsByKey.set(key, dayMap);
  }

  return [...metaByKey.entries()]
    .map(([key, jobType]) => {
      const dayMap = dayCountsByKey.get(key) ?? new Map<string, number>();
      const points = dateKeys.map((date) => ({ date, value: dayMap.get(date) ?? 0 }));
      return {
        appId,
        appName,
        jobType,
        totalRequests: points.reduce((sum, point) => sum + point.value, 0),
        points,
      };
    })
    .filter((series) => series.totalRequests > 0)
    .sort((a, b) => b.totalRequests - a.totalRequests);
}

function SummaryTile({
  label,
  value,
  mono,
}: Readonly<{ label: string; value: string; mono?: boolean }>) {
  return (
    <div className="rounded-lg border border-white/[0.05] bg-black/20 px-3 py-3">
      <p className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-zinc-500">
        {label}
      </p>
      <p
        className={`mt-1 text-sm text-zinc-100 ${mono ? "font-mono tabular-nums" : ""}`}
      >
        {value}
      </p>
    </div>
  );
}

export default async function AppIdentityDetailPage({
  params,
}: Readonly<{ params: Promise<{ id: string; externalUserId: string }> }>) {
  const { id, externalUserId: rawExternalUserId } = await params;
  // Next.js already decodes dynamic segments — do not decodeURIComponent again.
  const externalUserId = rawExternalUserId.trim();
  if (!externalUserId) {
    notFound();
  }

  let providerAuth: Awaited<ReturnType<typeof getAuthorizedProviderApp>> | null = null;
  try {
    providerAuth = await getAuthorizedProviderApp(id);
  } catch (err) {
    console.warn(
      "app-identity-detail: auth resolution failed",
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

  const [identities, dailyRows] = await Promise.all([
    openMeterConfigured
      ? listAppIdentities({
          clientId: app.id,
          startDate: cycle.start,
          endDate: cycle.end,
        }).catch((err) => {
          console.warn(
            "app-identity-detail: listAppIdentities failed",
            app.id,
            err instanceof Error ? err.message : String(err),
          );
          return [];
        })
      : Promise.resolve([]),
    openMeterConfigured
      ? queryOpenMeterUserDailyByPipeline({
          clientId: app.id,
          startDate: cycle.start,
          endDate: cycle.end,
          externalUserId,
        }).catch(() => [])
      : Promise.resolve([]),
  ]);

  const identity = identities.find((row) => row.externalUserId === externalUserId);
  const todayKeyUtc = new Date().toISOString().slice(0, 10);
  const dateKeys = dateKeysInclusiveUtc(cycle.start, cycle.end).filter(
    (date) => date <= todayKeyUtc,
  );
  const series = buildIdentitySeries(dailyRows, dateKeys, app.name, app.id);

  let statusLabel = "unknown";
  if (identity) {
    statusLabel = identity.provisioned ? identity.status : "unprovisioned";
  }

  return (
    <DashboardLayout>
      <AppSectionBreadcrumb
        appId={id}
        appName={app.name}
        parentSection={{ label: "Identities", href: `/apps/${id}/identities` }}
        section="Identity"
      />

      <div className="mb-6 sm:mb-8">
        <h1 className="break-all font-mono text-lg font-bold text-zinc-100 sm:text-xl">
          {externalUserId}
        </h1>
        <p className="mt-1 text-xs text-zinc-500 sm:text-sm">
          Usage for this identity in the current billing cycle.
        </p>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:mb-8 sm:grid-cols-4">
        <SummaryTile
          label="Requests"
          value={(identity?.requestCount ?? 0).toLocaleString()}
          mono
        />
        <SummaryTile
          label="Network fee"
          value={formatUsdMicrosString(identity?.networkFeeUsdMicros ?? "0") ?? "$0.00"}
          mono
        />
        <SummaryTile
          label="Duration"
          value={formatBillableDuration(identity?.billableSecs ?? "0")}
          mono
        />
        <SummaryTile
          label="Status"
          value={statusLabel}
        />
      </div>

      {identity?.apiKey ? (
        <div className="mb-6 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-sm sm:mb-8">
          <span className="text-zinc-500">API key</span>
          <span className="mx-2 text-zinc-700">·</span>
          <Link
            href={`/apps/${id}?tab=credentials`}
            className="font-mono text-xs text-emerald-400 transition-colors hover:text-emerald-300"
          >
            {identity.apiKey.label || identity.apiKey.keyPrefix || identity.apiKey.id}
          </Link>
          {identity.apiKeyCount > 1 ? (
            <span className="ml-2 text-xs text-zinc-600">
              +{identity.apiKeyCount - 1} more
            </span>
          ) : null}
        </div>
      ) : null}

      <section className="mb-6 rounded-xl border border-white/[0.06] bg-white/[0.02] p-5 sm:mb-8">
        <h2 className="text-sm font-semibold text-zinc-200">Usage over billing period</h2>
        <p className="mb-4 mt-1 text-xs text-zinc-500">
          Split by pipeline / model.
        </p>
        {series.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-500">
            No metered usage for this identity in the current cycle.
          </p>
        ) : (
          <UsageBreakdownChart
            series={series}
            valueLabel="Usage"
            height={220}
            maxSeries={8}
            showMetricToggle={false}
          />
        )}
      </section>

      <IdentityRequestLog appId={id} externalUserId={externalUserId} />
    </DashboardLayout>
  );
}
