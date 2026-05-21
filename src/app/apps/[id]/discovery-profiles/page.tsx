import { redirect } from "next/navigation";

/**
 * Network discovery allowlist now lives on the main app page under Billing
 * Plans (`?tab=plans`). Keep this URL as a redirect for bookmarks.
 */
export default async function AppDiscoveryProfilesRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/apps/${id}?tab=plans`);
}
