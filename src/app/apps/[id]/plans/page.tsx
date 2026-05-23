import { redirect } from "next/navigation";

/**
 * Plans now live as a tab in the main app settings page.
 * Redirect old bookmarks and links.
 */
export default async function AppPlansRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/apps/${id}?tab=plans`);
}
