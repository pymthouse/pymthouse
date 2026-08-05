import { redirect } from "next/navigation";

/**
 * Discovery profiles now live under Billing Plans.
 * Keep this URL as a redirect for bookmarks.
 */
export default async function AppDiscoveryProfilesRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/apps/${id}/plans`);
}
