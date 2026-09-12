import type { Account, FindAccount } from "oidc-provider";
import { getEndUserBySubject, getUserBySubject } from "../repo/accounts";

export const findAccount: FindAccount = async (_ctx, sub) => {
  const user = await getUserBySubject(sub);
  if (user) {
    const account: Account = {
      accountId: user.id,
      async claims(_use, scope) {
        const scopes = scope ? scope.split(" ") : [];
        const claims: { sub: string; [key: string]: unknown } = { sub: user.id };
        if (scopes.includes("email")) claims.email = user.email;
        if (scopes.includes("profile")) claims.name = user.name;
        return claims;
      },
    };
    return account;
  }

  const endUser = await getEndUserBySubject(sub);
  if (endUser) {
    const account: Account = {
      accountId: endUser.id,
      async claims(_use, scope) {
        const scopes = scope ? scope.split(" ") : [];
        const claims: { sub: string; [key: string]: unknown } = { sub: endUser.id };
        if (scopes.includes("email")) claims.email = endUser.email;
        if (scopes.includes("profile")) claims.name = endUser.name;
        return claims;
      },
    };
    return account;
  }

  return undefined;
};
