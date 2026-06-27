"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";

interface NavItem {
  label: string;
  href: string;
  icon: string;
  roles?: string[];
  group?: string; // if set, item is shown under this group heading
  external?: boolean; // if set, opens in a new tab
}

const API_REFERENCE_URL = "https://pymthouse.com/api/v1/docs";
const DOCS_URL = "https://docs.pymthouse.com";

const allNavItems: NavItem[] = [
  {
    label: "Dashboard",
    href: "/dashboard",
    icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6",
  },
  {
    label: "My Apps",
    href: "/apps",
    icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
  },
  {
    label: "Signer Admin",
    href: "/signer",
    icon: "M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z",
    roles: ["admin"],
    group: "Admin",
  },
  {
    label: "App Reviews",
    href: "/admin/apps",
    icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
    roles: ["admin"],
    group: "Admin",
  },
  {
    label: "OIDC Clients",
    href: "/admin/oidc-clients",
    icon: "M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z",
    roles: ["admin"],
    group: "Admin",
  },
  {
    label: "Streams",
    href: "/streams",
    icon: "M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z",
    roles: ["admin", "operator"],
  },
  {
    label: "Users",
    href: "/users",
    icon: "M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z",
    roles: ["admin", "operator"],
  },
  {
    label: "Usage",
    href: "/billing",
    icon: "M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z",
  },
  {
    label: "Docs",
    href: DOCS_URL,
    icon: "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253",
    external: true,
    group: "Resources",
  },
  {
    label: "API Reference",
    href: API_REFERENCE_URL,
    icon: "M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4",
    external: true,
    group: "Resources",
  },
];

const SKELETON_NAV_KEYS = ["nav-a", "nav-b", "nav-c", "nav-d", "nav-e"] as const;
const SKELETON_CARD_KEYS = ["card-a", "card-b", "card-c"] as const;

function roleBadgeClassName(role: string): string {
  if (role === "admin") {
    return "bg-amber-500/15 text-amber-400";
  }
  if (role === "operator") {
    return "bg-blue-500/15 text-blue-400";
  }
  return "bg-zinc-700/60 text-zinc-400";
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, status } = useSession();
  const [mobileNavState, setMobileNavState] = useState({
    open: false,
    pathname,
  });
  const mobileNavOpen = mobileNavState.pathname === pathname && mobileNavState.open;
  const setMobileNavOpen = (open: boolean) => {
    setMobileNavState({
      open,
      pathname,
    });
  };

  const userRole = (session?.user as Record<string, unknown> | undefined)?.role as string | undefined;

  const navItems = useMemo(
    () =>
      allNavItems.filter(
        (item) => !item.roles || (userRole && item.roles.includes(userRole))
      ),
    [userRole]
  );

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/");
    }
  }, [status, router]);

  if (status === "loading") {
    return (
      <div className="flex h-screen w-full bg-zinc-950">
        <div className="w-64 shrink-0 border-r border-zinc-800 bg-zinc-900/50 p-4 space-y-2">
          <div className="h-8 w-32 rounded-lg bg-zinc-800 animate-pulse mb-6" />
          {SKELETON_NAV_KEYS.map((key) => (
            <div key={key} className="h-9 rounded-lg bg-zinc-800/60 animate-pulse" />
          ))}
        </div>
        <div className="flex-1 p-8 space-y-6">
          <div className="h-8 w-48 rounded-lg bg-zinc-800 animate-pulse" />
          <div className="grid grid-cols-3 gap-4">
            {SKELETON_CARD_KEYS.map((key) => (
              <div key={key} className="h-28 rounded-xl bg-zinc-900/50 border border-zinc-800 animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return null;
  }

  return (
    <div className="flex h-screen w-full min-w-0 flex-col overflow-hidden bg-zinc-950 text-zinc-100 lg:flex-row">
      {mobileNavOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          aria-label="Close menu"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      {/* Main first so mobile flex allocates full width; sidebar is fixed/overlaid on small screens */}
      {/* Main content */}
      <main className="relative z-0 flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden lg:order-2">
        <header className="flex shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-4 py-3 lg:hidden">
          <button
            type="button"
            className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Open menu"
            onClick={() => setMobileNavOpen(true)}
          >
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </button>
          <span className="font-semibold tracking-tight text-emerald-400">pymthouse</span>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">{children}</div>
        </div>
      </main>

      {/* Sidebar (drawer on small screens; in-flow left column from lg+) */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex h-full w-64 shrink-0 flex-col border-zinc-800/80 bg-zinc-950/80 backdrop-blur-md transition-transform duration-200 ease-out lg:relative lg:inset-auto lg:z-auto lg:translate-x-0 lg:shrink-0 lg:border-r ${
          mobileNavOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        } lg:order-1`}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 p-4 lg:p-6">
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              <span className="text-emerald-400">pymt</span>house
            </h1>
            <p className="text-xs text-zinc-500 mt-1">Identity & Payments</p>
          </div>
          <button
            type="button"
            className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 lg:hidden"
            aria-label="Close menu"
            onClick={() => setMobileNavOpen(false)}
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-3 pt-4 lg:pt-3">
          {(() => {
            const adminItems = navItems.filter((i) => i.group === "Admin");
            const resourceItems = navItems.filter((i) => i.group === "Resources");
            const otherItems = navItems.filter((i) => !i.group);

            const renderNavLink = (item: NavItem, isActive: boolean) => {
              const linkClass = `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 ${
                isActive
                  ? "bg-emerald-500/10 text-emerald-400 shadow-[inset_0_0_0_1px_rgba(52,211,153,0.12)]"
                  : "text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]"
              }`;
              const icon = (
                <svg
                  className="w-5 h-5 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d={item.icon}
                  />
                </svg>
              );
              if (item.external) {
                return (
                  <a
                    key={item.href}
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkClass}
                  >
                    {icon}
                    {item.label}
                    <svg
                      className="w-3 h-3 ml-auto shrink-0 opacity-40"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                      />
                    </svg>
                  </a>
                );
              }
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileNavOpen(false)}
                  className={linkClass}
                >
                  {icon}
                  {item.label}
                </Link>
              );
            };

            return (
              <>
                {otherItems.map((item) => {
                  const isActive =
                    item.href === "/dashboard"
                      ? pathname === "/dashboard"
                      : pathname.startsWith(item.href);
                  return renderNavLink(item, isActive);
                })}
                {adminItems.length > 0 && (
                  <>
                    <div className="pt-4 mt-2 border-t border-zinc-800">
                      <p className="px-3 py-1.5 text-xs font-medium text-zinc-500 uppercase tracking-wider">
                        Admin
                      </p>
                    </div>
                    {adminItems.map((item) => {
                      const isActive = pathname.startsWith(item.href);
                      return renderNavLink(item, isActive);
                    })}
                  </>
                )}
                {resourceItems.length > 0 && (
                  <>
                    <div className="pt-4 mt-2 border-t border-zinc-800">
                      <p className="px-3 py-1.5 text-xs font-medium text-zinc-500 uppercase tracking-wider">
                        Resources
                      </p>
                    </div>
                    {resourceItems.map((item) => renderNavLink(item, false))}
                  </>
                )}
              </>
            );
          })()}
        </nav>

        {/* User info */}
        {session?.user && (
          <div className="p-4 border-t border-zinc-800 space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400 text-sm font-bold shrink-0">
                {session.user.name?.[0]?.toUpperCase() || "?"}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {session.user.name}
                </p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <p className="text-xs text-zinc-500 truncate">
                    {session.user.email}
                  </p>
                  {userRole && (
                    <span
                      className={`shrink-0 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${roleBadgeClassName(userRole)}`}
                    >
                      {userRole}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <button
              onClick={() => signOut({ callbackUrl: "/" })}
              className="w-full flex items-center justify-center gap-2 rounded-lg border border-zinc-700/60 bg-zinc-800/40 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Sign out
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}
