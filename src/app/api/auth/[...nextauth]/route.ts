import NextAuth from "next-auth";
import { authOptions } from "@/platform/auth/next-auth-options";

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
