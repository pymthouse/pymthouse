import { redirect } from "next/navigation";

/** Profile tab canonical URL is `/apps/[id]`. */
export default async function AppProfileRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/apps/${id}`);
}
