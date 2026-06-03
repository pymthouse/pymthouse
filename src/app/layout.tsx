import type { Metadata } from "next";
import { getServerSession } from "next-auth";
import "@turnkey/react-wallet-kit/styles.css";
import "./globals.css";
import Providers from "@/components/Providers";
import { authOptions } from "@/lib/next-auth-options";

export const metadata: Metadata = {
  title: "pymthouse - Identity & Payment Infrastructure",
  description:
    "Whitelabel identity and payment infrastructure for Livepeer orchestrators",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);

  return (
    <html lang="en" className="dark">
      <body className="antialiased bg-zinc-950 text-zinc-100">
        <Providers session={session}>{children}</Providers>
      </body>
    </html>
  );
}
