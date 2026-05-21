import { redirect } from "next/navigation";

/**
 * Credentials & URLs now lives as a tab in the main app settings page.
 * Keep this URL for deep links.
 */
export default async function AppCredentialsRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/apps/${id}?tab=credentials`);
}
