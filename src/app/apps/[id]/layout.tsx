import AppSettingsRouteShell from "@/components/apps/AppSettingsRouteShell";

/** Keep the settings client mounted while switching left-nav tabs. */
export default function AppDetailLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <AppSettingsRouteShell>{children}</AppSettingsRouteShell>;
}
