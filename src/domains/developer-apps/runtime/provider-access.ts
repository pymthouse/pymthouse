import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/platform/auth/next-auth-options";
import {
  getProviderAdminMembership,
  getProviderApp,
} from "../repo/provider-access";

export async function getAuthorizedProviderApp(appId: string) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;

  const userId = (session.user as Record<string, unknown>).id as string | undefined;
  const role = (session.user as Record<string, unknown>).role as string | undefined;
  if (!userId) return null;

  const app = await getProviderApp(appId);
  if (!app) return null;

  if (role === "admin" || app.ownerId === userId || (await getProviderAdminMembership(userId, app.id))) {
    return { app, userId, role: role ?? "developer" };
  }

  return null;
}

export type AuthorizedProviderApp = NonNullable<
  Awaited<ReturnType<typeof getAuthorizedProviderApp>>
>;

export async function canEditProviderApp(auth: AuthorizedProviderApp): Promise<boolean> {
  if (auth.role === "admin") return true;
  if (auth.app.ownerId === auth.userId) return true;

  const membership = await getProviderAdminMembership(auth.userId, auth.app.id);
  if (!membership) return false;
  return membership.role === "owner" || membership.role === "admin";
}

export function appEditForbiddenResponse() {
  return NextResponse.json(
    {
      error: "Only platform or app administrators can modify this app.",
    },
    { status: 403 },
  );
}
