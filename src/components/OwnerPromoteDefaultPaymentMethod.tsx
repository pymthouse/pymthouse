"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * After Stripe setup Checkout returns with `?pm=attached`, promote the first
 * attached card to default via authenticated POST/PATCH — never mutate billing
 * state from a GET page render (CSRF).
 */
export default function OwnerPromoteDefaultPaymentMethod({
  replaceHref,
}: Readonly<{
  /** Same-origin path to replace once promotion has been attempted. */
  replaceHref: string;
}>) {
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    let cancelled = false;
    async function run() {
      try {
        await fetch("/api/v1/me/billing/payment-method", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ensureDefault: true }),
        });
      } catch {
        // Best-effort; list/UI still works with attached-but-not-default until retry.
      }
      if (cancelled) return;
      router.replace(replaceHref);
      router.refresh();
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [replaceHref, router]);

  return null;
}
