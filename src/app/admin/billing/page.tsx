"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import DashboardLayout from "@/components/DashboardLayout";

const CS_URL = process.env.NEXT_PUBLIC_CUSTOMER_SERVICE_URL?.trim() || "";

/**
 * Platform Billing UI moved to the customer-service app.
 * This route remains as a pointer so old bookmarks do not 404.
 */
export default function AdminPlatformBillingMovedPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const userRole = (session?.user as Record<string, unknown> | undefined)?.role as
    | string
    | undefined;

  useEffect(() => {
    if (status === "unauthenticated" || (status === "authenticated" && userRole !== "admin")) {
      router.push("/");
      return;
    }
    if (status === "authenticated" && userRole === "admin" && CS_URL) {
      window.location.href = CS_URL;
    }
  }, [status, userRole, router]);

  if (status === "loading" || (status === "authenticated" && userRole !== "admin")) {
    return (
      <DashboardLayout>
        <div className="p-8 text-zinc-400">Loading…</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-xl space-y-4 p-8">
        <h1 className="text-xl font-semibold text-zinc-100">Platform Billing moved</h1>
        <p className="text-sm text-zinc-400">
          Starter defaults, Owner Paid tiers, owner overrides, wallet inspection, and
          manual credit grants now live in the customer-service console.
        </p>
        {CS_URL ? (
          <a
            href={CS_URL}
            className="inline-flex rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
          >
            Open customer-service
          </a>
        ) : (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            Set <code className="font-mono text-xs">NEXT_PUBLIC_CUSTOMER_SERVICE_URL</code>{" "}
            to the customer-service app origin (e.g.{" "}
            <code className="font-mono text-xs">http://localhost:3010</code>).
          </p>
        )}
        <p className="text-xs text-zinc-600">
          Admin APIs remain on this host under{" "}
          <code className="font-mono">/api/v1/admin/billing/*</code>.{" "}
          <Link href="/admin/apps" className="text-zinc-400 underline hover:text-zinc-200">
            Back to admin
          </Link>
        </p>
      </div>
    </DashboardLayout>
  );
}
