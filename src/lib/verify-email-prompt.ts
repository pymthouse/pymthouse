import { eq } from "drizzle-orm";
import { db } from "@/db/index";
import { users } from "@/db/schema";
import { getTurnkeyServerApiClient } from "@/lib/onramp/turnkey-client";
import {
  brandedSignInIdentity,
  type BrandedSignIn,
} from "@/lib/turnkey-sign-in-methods";

export function usableVerifyEmail(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase() ?? "";
  if (!value.includes("@") || value.endsWith("@turnkey.local")) return null;
  return value;
}

export async function loadVerifyEmailPrompt(userId: string): Promise<{
  identity: BrandedSignIn | null;
  email: string | null;
}> {
  const rows = await db
    .select({
      name: users.name,
      turnkeyUserId: users.turnkeyUserId,
      turnkeySubOrgId: users.turnkeySubOrgId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return { identity: null, email: null };

  let providers: Parameters<typeof brandedSignInIdentity>[0] = [];
  let name = row.name;
  let email: string | null = null;
  if (row.turnkeySubOrgId) {
    try {
      const result = await getTurnkeyServerApiClient().getUsers({
        organizationId: row.turnkeySubOrgId,
      });
      const match =
        (result.users ?? []).find((user) => user.userId === row.turnkeyUserId) ??
        result.users?.[0];
      providers = match?.oauthProviders ?? [];
      name = match?.userName?.trim() || name;
      email = usableVerifyEmail(match?.userEmail);
    } catch (err) {
      console.error("Could not read the Turnkey sign-in for email verification", err);
    }
  }

  return {
    identity: brandedSignInIdentity(providers, name),
    email,
  };
}
