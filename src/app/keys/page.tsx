export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/next-auth-options";
import DashboardLayout from "@/components/DashboardLayout";
import ApiKeysManager from "@/components/keys/ApiKeysManager";

export default async function KeysPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  return (
    <DashboardLayout>
      <ApiKeysManager />
    </DashboardLayout>
  );
}
