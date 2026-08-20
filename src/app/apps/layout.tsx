import DashboardLayout from "@/components/DashboardLayout";

/** Persist the dashboard chrome across My Apps, create, and app detail tabs. */
export default function AppsLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
