export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { redirect } from "next/navigation";
import { db } from "@/db/index";
import { signerConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import DashboardLayout from "@/components/DashboardLayout";
import AppsListSection from "@/components/apps/AppsListSection";
import AdminAppsHome from "@/components/apps/AdminAppsHome";
import MyAppsShortcutTiles from "@/components/apps/MyAppsShortcutTiles";
import { listUserAccessibleApps } from "@/lib/user-apps";
import { syncSignerStatus } from "@/lib/signer-proxy";
import NetworkLiveIndicator from "@/components/NetworkLiveIndicator";

function myAppsSummaryText(count: number): string {
  if (count === 0) return "No apps yet — create one to get started.";
  if (count === 1) return "1 app — open settings or usage from the icons.";
  return `${count} apps — open settings or usage from the icons.`;
}

export default async function AppsPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  const role = (session.user as Record<string, unknown>)?.role as string;
  const userId = (session.user as Record<string, unknown>)?.id as string;

  if (role === "admin" || role === "operator") {
    return (
      <DashboardLayout>
        <AdminMyApps userId={userId} />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <DeveloperMyApps userId={userId} />
    </DashboardLayout>
  );
}

async function DeveloperMyApps({ userId }: Readonly<{ userId: string }>) {
  const apps = userId ? await listUserAccessibleApps(userId) : [];

  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-zinc-100">My Apps</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Manage your provider applications
        </p>
      </div>

      <MyAppsShortcutTiles />

      <AppsListSection
        apps={apps}
        title=""
        summaryText={myAppsSummaryText(apps.length)}
        emptyStateTitle="No apps yet."
        emptyStateBody="Create your first provider app to configure identity, plans, user management, and signer access."
      />
    </>
  );
}

async function AdminMyApps({ userId }: Readonly<{ userId: string }>) {
  await syncSignerStatus();

  const [myApps, signerRows] = await Promise.all([
    userId ? listUserAccessibleApps(userId) : Promise.resolve([]),
    db.select().from(signerConfig).where(eq(signerConfig.id, "default")).limit(1),
  ]);

  const signer = signerRows[0];
  const signerOnline = signer?.status === "running";
  let signerDetail = "no address";
  if (signer?.ethAddress) {
    signerDetail = `${signer.ethAddress.slice(0, 6)}...${signer.ethAddress.slice(-4)}`;
  } else if (signerOnline) {
    signerDetail = "connected";
  } else if (signer?.status) {
    signerDetail = signer.status;
  }

  return (
    <>
      <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">My Apps</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Manage provider applications
          </p>
        </div>
        <NetworkLiveIndicator
          online={signerOnline}
          detail={signerDetail}
          statusLabel={signer?.status || "offline"}
        />
      </div>

      <AdminAppsHome myApps={myApps} />
    </>
  );
}
