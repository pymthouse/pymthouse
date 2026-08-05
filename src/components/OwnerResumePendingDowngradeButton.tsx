"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

/**
 * Cancels a scheduled Sandbox Starter downgrade (OpenMeter restore).
 * No charge — keeps the current Owner Paid plan.
 */
export default function OwnerResumePendingDowngradeButton({
  currentPlanName,
}: Readonly<{
  currentPlanName: string | null;
}>) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKeyRef = useRef(`owner-resume:${crypto.randomUUID()}`);

  const labelName = currentPlanName?.trim() || "your plan";

  async function onResume() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/me/billing/resume-paid-plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKeyRef.current,
        },
        body: JSON.stringify({ confirm: true }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error || "Could not resume plan");
      }
      router.push("/billing?resumed=1");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col items-start gap-1">
      <button
        type="button"
        className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
        disabled={busy}
        onClick={() => void onResume()}
      >
        {busy ? "Resuming…" : `Keep ${labelName} — resume`}
      </button>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
    </div>
  );
}
