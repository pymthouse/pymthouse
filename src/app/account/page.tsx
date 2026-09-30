export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { AccountManagementPanels } from "@/components/AccountManagementPanels";
import DashboardLayout from "@/components/DashboardLayout";
import { authOptions } from "@/lib/next-auth-options";

export default async function AccountPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Account</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Delete this PymtHouse login. Apps you own stay in place until an
            admin reassigns them.
          </p>
        </div>
        <AccountManagementPanels />
      </div>
    </DashboardLayout>
  );
}
