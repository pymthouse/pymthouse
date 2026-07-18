import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { db } from "@/db/index";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { validateBearerToken, hasScope } from "@/lib/auth";
import {
  findOrCreateDeveloperUser,
  verifyTurnkeySessionJwt,
} from "@/lib/turnkey";
import { getNextAuthSecret } from "@/lib/next-auth-secret";

const nextAuthSecret = getNextAuthSecret();

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      id: "token",
      name: "Admin Token",
      credentials: {
        token: { label: "Bearer Token", type: "text", placeholder: "pmth_..." },
      },
      async authorize(credentials) {
        if (!credentials?.token) return null;

        const auth = await validateBearerToken(credentials.token);
        if (!auth) return null;
        if (!hasScope(auth.scopes, "admin")) return null;
        if (!auth.userId) return null;

        const userRows = await db
          .select()
          .from(users)
          .where(eq(users.id, auth.userId))
          .limit(1);
        const user = userRows[0];

        if (!user) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name || user.email,
          role: user.role,
        };
      },
    }),

    CredentialsProvider({
      id: "turnkey-wallet",
      name: "Turnkey Wallet",
      credentials: {
        turnkeySessionJwt: { label: "Turnkey Session JWT", type: "text" },
        walletAddress: { label: "Wallet Address", type: "text" },
        email: { label: "Email", type: "text" },
        name: { label: "Name", type: "text" },
      },
      async authorize(credentials) {
        if (!credentials?.turnkeySessionJwt) return null;

        const claims = await verifyTurnkeySessionJwt(
          credentials.turnkeySessionJwt,
        );
        if (!claims) return null;

        const walletRaw = credentials.walletAddress?.trim();
        const emailRaw = credentials.email?.trim();
        const nameRaw = credentials.name?.trim();

        const { id } = await findOrCreateDeveloperUser(
          claims.userId,
          walletRaw || undefined,
          nameRaw || undefined,
          emailRaw || undefined,
        );

        const userRows = await db
          .select()
          .from(users)
          .where(eq(users.id, id))
          .limit(1);
        const user = userRows[0];

        if (!user) return null;

        return {
          id: user.id,
          email: user.email || undefined,
          name: user.name || user.walletAddress || "Developer",
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    async signIn({ account }) {
      if (!account) return false;

      if (account.provider === "token") return true;
      if (account.provider === "turnkey-wallet") return true;

      return false;
    },
    async session({ session, token }) {
      if (session.user && token.userId) {
        (session.user as Record<string, unknown>).id = token.userId;
        (session.user as Record<string, unknown>).role = token.role;
      }
      return session;
    },
    async jwt({ token, user, account }) {
      if (account) {
        token.provider = account.provider;
      }
      if (user?.id) {
        token.userId = user.id;
        token.role = (user as { role?: string }).role;
      } else if (token.userId && token.role == null) {
        // One-time backfill for JWTs minted before role was stashed on the token.
        const rows = await db
          .select({ role: users.role })
          .from(users)
          .where(eq(users.id, token.userId as string))
          .limit(1);
        if (rows[0]) {
          token.role = rows[0].role;
        }
      }
      return token;
    },
  },
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/login",
  },
  secret: nextAuthSecret,
};
