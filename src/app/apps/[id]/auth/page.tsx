import { redirect } from "next/navigation";

/** Auth settings live under App profile. */
export default async function AppAuthRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/apps/${id}`);
}
