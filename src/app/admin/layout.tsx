import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/platform/auth/next-auth-options";

/**
 * Admin layout: protects all /admin/* routes.
 * Only users with role "admin" can access.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);
  const role = (session?.user as Record<string, unknown> | undefined)?.role as
    | string
    | undefined;

  if (!session?.user || role !== "admin") {
    redirect("/");
  }

  return <>{children}</>;
}
