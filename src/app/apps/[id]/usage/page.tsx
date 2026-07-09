export const dynamic = "force-dynamic";

import BillingUsageDashboard from "@/components/BillingUsageDashboard";
import FundAccountOnRampPanel from "@/components/apps/FundAccountOnRampPanel";
import { authOptions } from "@/lib/next-auth-options";
import { getAuthorizedProviderApp } from "@/lib/provider-apps";
import { getServerSession } from "next-auth";

export default async function AppUsagePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const providerAuth = userId ? await getAuthorizedProviderApp(id) : null;
  const showFundPanel =
    Boolean(userId) && providerAuth?.app.ownerId === userId;

  return (
    <BillingUsageDashboard
      filterAppId={id}
      fundPanel={
        showFundPanel && userId ? (
          <FundAccountOnRampPanel
            clientId={id}
            ownerExternalUserId={userId}
          />
        ) : null
      }
    />
  );
}
