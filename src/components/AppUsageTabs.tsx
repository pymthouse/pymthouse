"use client";

import Link from "next/link";

function TabLink({
  active,
  href,
  children,
}: Readonly<{ active: boolean; href: string; children: React.ReactNode }>) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
        active
          ? "bg-emerald-500/15 text-emerald-400 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.25)]"
          : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
      }`}
    >
      {children}
    </Link>
  );
}

export default function AppUsageTabs({
  appId,
  active,
}: Readonly<{
  appId: string;
  active: "usage" | "users";
}>) {
  return (
    <div className="mb-6 flex shrink-0 items-center gap-1 self-start rounded-lg bg-black/20 p-0.5">
      <TabLink active={active === "usage"} href={`/apps/${appId}/usage`}>
        Usage
      </TabLink>
      <TabLink active={active === "users"} href={`/apps/${appId}/usage/users`}>
        All Users
      </TabLink>
    </div>
  );
}
