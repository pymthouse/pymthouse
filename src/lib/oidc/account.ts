/**
 * findAccount — resolve a user by `sub` and return claims based on granted scopes.
 */

import type { Account, FindAccount } from "oidc-provider";
import { db } from "@/db/index";
import { users, endUsers } from "@/db/schema";
import { eq } from "drizzle-orm";

export const findAccount: FindAccount = async (_ctx, sub) => {
  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.id, sub))
    .limit(1);
  const user = userRows[0];

  if (user) {
    const account: Account = {
      accountId: user.id,
      async claims(_use, scope) {
        const scopes = scope ? scope.split(" ") : [];

        const claims: { sub: string; [key: string]: unknown } = { sub: user.id };

        if (scopes.includes("email")) {
          claims.email = user.email;
        }

        if (scopes.includes("profile")) {
          claims.name = user.name;
        }

        return claims;
      },
    };

    return account;
  }

  const endUserRows = await db
    .select()
    .from(endUsers)
    .where(eq(endUsers.id, sub))
    .limit(1);
  const endUser = endUserRows[0];

  if (endUser) {
    const account: Account = {
      accountId: endUser.id,
      async claims(_use, scope) {
        const scopes = scope ? scope.split(" ") : [];

        const claims: { sub: string; [key: string]: unknown } = { sub: endUser.id };

        if (scopes.includes("email")) {
          claims.email = endUser.email;
        }

        if (scopes.includes("profile")) {
          claims.name = endUser.name;
        }

        return claims;
      },
    };

    return account;
  }

  return undefined;
};
