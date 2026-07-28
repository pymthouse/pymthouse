export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/next-auth-options";
import DashboardLayout from "@/components/DashboardLayout";
import ApiKeysManager from "@/components/keys/ApiKeysManager";

export default async function KeysPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  const role = (session.user as Record<string, unknown>)?.role as string | undefined;
  if (role === "admin" || role === "operator") {
    redirect("/apps");
  }

  return (
    <DashboardLayout>
      <ApiKeysManager />
    </DashboardLayout>
  );
}
