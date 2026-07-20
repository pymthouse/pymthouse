export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { db } from "@/db/index";
import { signerConfig, streamSessions, transactions } from "@/db/schema";
import { eq } from "drizzle-orm";
import DashboardLayout from "@/components/DashboardLayout";
import SignerControlPanel from "@/components/SignerControlPanel";
import SignerConfigForm from "@/components/SignerConfigForm";
import SignerLogs from "@/components/SignerLogs";
import SignerLiveStats from "@/components/SignerLiveStats";
import {
  ACTIVE_STREAM_PAYMENT_WINDOW_MINUTES,
  countActiveStreamsByRecentPayment,
} from "@/lib/active-streams";
import {
  getIssuer,
  getJwksUrlForLocalSignerDmzContainer,
} from "@/lib/oidc/issuer-urls";
import { resolveDmzHostPort } from "@/lib/signer-dmz-host-port";
import {
  getSignerUrl,
  getSignerUrlSource,
  isManagedRemoteSigner,
  syncSignerStatus,
} from "@/lib/signer-proxy";

function formatWei(wei: string | null): string {
  if (!wei || wei === "0") return "0 WEI";
  const value = BigInt(wei);
  const eth = Number(value) / 1e18;
  if (eth < 0.001) return `${wei} WEI`;
  return `${eth.toFixed(6)} ETH`;
}

export default async function SignerPage() {
  const session = await getServerSession(authOptions);
  const role = (session?.user as Record<string, unknown> | undefined)?.role as
    | string
    | undefined;
  if (!session?.user || role !== "admin") {
    redirect("/");
  }

  await syncSignerStatus();

  const signerRows = await db
    .select()
    .from(signerConfig)
    .where(eq(signerConfig.id, "default"))
    .limit(1);
  const signer = signerRows[0];

  if (!signer) {
    return (
      <DashboardLayout>
        <div className="text-center py-16 text-zinc-500">
          Signer config not initialized. Restart the app.
        </div>
      </DashboardLayout>
    );
  }

  const [activeStreamCount, allSessions, allTxns] = await Promise.all([
    countActiveStreamsByRecentPayment(),
    db.select().from(streamSessions),
    db.select({ id: transactions.id }).from(transactions),
  ]);

  let totalFeeWei = 0n;
  for (const s of allSessions) {
    totalFeeWei += BigInt(s.totalFeeWei);
  }

  const statusColors: Record<string, string> = {
    running: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    stopped: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
    error: "bg-red-500/20 text-red-400 border-red-500/30",
  };

  const oidcIssuer = getIssuer();
  const oidcAudience = oidcIssuer;
  const oidcJwksUrl = getJwksUrlForLocalSignerDmzContainer();
  const dmzHostPort = resolveDmzHostPort(signer.signerPort);
  const effectiveSignerUrl = getSignerUrl(signer);
  const signerUrlSource = getSignerUrlSource(signer);
  const managedRemote = isManagedRemoteSigner(signer);

  return (
    <DashboardLayout>
      {managedRemote && (
        <div className="mb-6 px-4 py-3 rounded-lg border border-blue-500/30 bg-blue-500/10 text-blue-200 text-sm">
          <span className="font-medium">Remote signer</span> — go-livepeer runs on{" "}
          <code className="text-blue-100/90">{effectiveSignerUrl}</code>, not on
          this host. Use <strong>Sync Status</strong> and live stats below; start/stop
          and container logs require Railway (or your deployment dashboard).
        </div>
      )}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h2 className="text-2xl font-bold tracking-tight">Signer Admin</h2>
          <span
            className={`px-2.5 py-0.5 text-xs font-medium rounded-full border ${
              statusColors[signer.status] || statusColors.stopped
            }`}
          >
            {signer.status}
          </span>
        </div>
        <p className="text-zinc-500 font-mono text-sm">
          {signer.ethAddress || "No address -- signer not connected"}
        </p>
      </div>

      {signer.lastError && (
        <div className="mb-6 px-4 py-3 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 text-sm">
          <span className="font-medium">Last error:</span> {signer.lastError}
        </div>
      )}

      {/* go-livepeer container config -- mirrors what the container shows */}
      <div className="border border-zinc-800 rounded-xl bg-zinc-900/30 mb-8 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-800">
          <h3 className="font-semibold text-zinc-200">
            go-livepeer Remote Signer
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            {managedRemote
              ? "OIDC/JWKS on the remote signer DMZ must match this app’s issuer (NEXTAUTH_URL). Configure ETH_RPC_URL and discovery on Railway."
              : "OIDC/JWKS match what the local signer-dmz container uses: same issuer as DMZ tokens from this app; JWKS URL is rewritten for Docker (host.docker.internal)."}
          </p>
        </div>
        <div className="font-mono text-sm">
          <ConfigRow label="Network" value={signer.network} />
          <ConfigRow
            label="DMZ host port"
            value={`127.0.0.1:${dmzHostPort} → Apache :8080 in container`}
          />
          <ConfigRow
            label="livepeer (in container)"
            value="HTTP 127.0.0.1:8081, CLI 127.0.0.1:4935 (not on host)"
          />
          <ConfigRow label="EthUrl" value={signer.ethRpcUrl} />
          <ConfigRow
            label="EthAcctAddr"
            value={signer.ethAcctAddr || signer.ethAddress || "(auto-generated)"}
            mono
          />
          <ConfigRow label="EthPassword" value="***" />
          <ConfigRow label="Datadir" value="/data" />
          <ConfigRow label="RemoteSigner" value="true" />
          <ConfigRow
            label="RemoteDiscovery"
            value={signer.remoteDiscovery === 1 ? "true" : "false"}
          />
          {signer.remoteDiscovery === 1 && (
            <>
              <ConfigRow
                label="OrchWebhookUrl"
                value={signer.orchWebhookUrl || "(empty)"}
                mono
              />
              <ConfigRow
                label="LiveAICapReportInterval"
                value={signer.liveAICapReportInterval || "(default)"}
              />
            </>
          )}
          <ConfigRow label="OIDC_ISSUER" value={oidcIssuer} mono />
          <ConfigRow label="OIDC_AUDIENCE" value={oidcAudience} mono />
          <ConfigRow label="JWKS_URI" value={oidcJwksUrl} mono />
          <ConfigRow label="Verbosity" value="99" />
        </div>
      </div>

      {/* Live signer state: CLI via SIGNER_CLI_URL (DMZ → /__signer_cli) */}
      <div className="border border-zinc-800 rounded-xl p-6 bg-zinc-900/30 mb-8">
        <SignerLiveStats />
      </div>

      {/* Activity stats from DB */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <StatCard
          label={`Active Streams (${ACTIVE_STREAM_PAYMENT_WINDOW_MINUTES}m)`}
          value={activeStreamCount.toString()}
          color="text-emerald-400"
        />
        <StatCard label="Total Streams" value={allSessions.length.toString()} />
        <StatCard label="Total Volume" value={formatWei(totalFeeWei.toString())} />
        <StatCard label="Transactions" value={allTxns.length.toString()} />
        <StatCard
          label="Platform Cut"
          value={`${signer.defaultCutPercent}%`}
        />
        <StatCard label="Billing Mode" value={signer.billingMode} />
      </div>

      {/* Control plane */}
      <div className="border border-zinc-800 rounded-xl p-6 bg-zinc-900/30 mb-8">
        <SignerControlPanel
          currentStatus={signer.status}
          managedRemote={managedRemote}
        />
      </div>

      {/* Container logs */}
      <div className="border border-zinc-800 rounded-xl p-6 bg-zinc-900/30 mb-8">
        <SignerLogs
          managedRemote={managedRemote}
          signerBaseUrl={effectiveSignerUrl}
        />
      </div>

      {/* pymthouse configuration */}
      <div className="border border-zinc-800 rounded-xl p-6 bg-zinc-900/30">
        <SignerConfigForm
          config={{
            name: signer.name,
            network: signer.network,
            ethRpcUrl: signer.ethRpcUrl,
            ethAcctAddr: signer.ethAcctAddr,
            signerPort: signer.signerPort,
            defaultCutPercent: signer.defaultCutPercent,
            billingMode: signer.billingMode,
            remoteDiscovery: signer.remoteDiscovery,
            orchWebhookUrl: signer.orchWebhookUrl,
            liveAICapReportInterval: signer.liveAICapReportInterval,
            signerUrl: signer.signerUrl,
            signerApiKey: signer.signerApiKey,
            oidcIssuer,
            oidcAudience,
            oidcJwksUrl,
            effectiveSignerUrl,
            signerUrlSource,
            managedRemote,
          }}
        />
      </div>
    </DashboardLayout>
  );
}

function ConfigRow({
  label,
  value,
  mono = false,
}: Readonly<{
  label: string;
  value: string;
  mono?: boolean;
}>) {
  return (
    <div className="flex border-b border-zinc-800/50 last:border-b-0">
      <div className="w-40 shrink-0 px-5 py-2.5 text-zinc-500 bg-zinc-900/50">
        {label}
      </div>
      <div
        className={`flex-1 px-5 py-2.5 text-zinc-300 ${
          mono ? "font-mono" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color = "text-zinc-200",
}: Readonly<{
  label: string;
  value: string;
  color?: string;
}>) {
  return (
    <div className="border border-zinc-800 rounded-xl p-4 bg-zinc-900/30">
      <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">
        {label}
      </p>
      <p className={`text-sm font-medium ${color}`}>{value}</p>
    </div>
  );
}
