import type { Metadata } from "next";
import { getServerSession } from "next-auth";
import "@turnkey/react-wallet-kit/styles.css";
import "./globals.css";
import Providers from "@/components/Providers";
import { authOptions } from "@/lib/next-auth-options";

const siteDescription =
  "Identity and payment infrastructure for Livepeer AI apps. OIDC authentication, usage metering, and managed payment signing.";

const metadataBase = (() => {
  try {
    return new URL(process.env.NEXTAUTH_URL ?? "https://pymthouse.com");
  } catch {
    return new URL("https://pymthouse.com");
  }
})();

export const metadata: Metadata = {
  title: "pymthouse - Platform Builder API for Livepeer Applications",
  description: siteDescription,
  metadataBase,
  openGraph: {
    title: "pymthouse - Platform Builder API for Livepeer Applications",
    description: siteDescription,
    siteName: "pymthouse",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "pymthouse - Platform Builder API for Livepeer Applications",
    description: siteDescription,
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getServerSession(authOptions);

  return (
    <html lang="en" className="dark">
      <body className="antialiased bg-zinc-950 text-zinc-100">
        <Providers session={session}>{children}</Providers>
      </body>
    </html>
  );
}
