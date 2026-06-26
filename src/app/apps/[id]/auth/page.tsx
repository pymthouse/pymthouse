import { redirect } from "next/navigation";

/**
 * Auth & scopes now lives on the App profile tab (Capabilities section).
 * Keep this URL for deep links.
 */
export default async function AppAuthRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/apps/${id}?tab=profile`);
}
