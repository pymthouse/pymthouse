export const dynamic = "force-dynamic";

import AppUsageScreen from "@/components/AppUsageScreen";

export default async function AppUsageUsersPage({
  params,
}: Readonly<{
  params: Promise<{ id: string }>;
}>) {
  const { id } = await params;
  return <AppUsageScreen appId={id} tab="users" />;
}
