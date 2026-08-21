"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import type { OnboardingPersona } from "@/lib/onboarding-types";
import {
  isOnboardingPersona,
  loginUrlForPersona,
  storeOnboardingIntent,
} from "@/lib/onboarding-intent";
import OnboardingShell from "@/components/onboarding/OnboardingShell";
import PersonaStep from "@/components/onboarding/PersonaStep";

/**
 * Public first viewport: pick Explorer/Builder, then Turnkey, then resume
 * on /onboarding with the chosen path. No real keys until after auth.
 */
export default function StartPreview() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawPersona = searchParams.get("persona");
  const highlight = isOnboardingPersona(rawPersona) ? rawPersona : null;
  const [busy, setBusy] = useState(false);

  const onSelect = useCallback(
    (persona: OnboardingPersona) => {
      setBusy(true);
      storeOnboardingIntent(persona);
      router.push(loginUrlForPersona(persona));
    },
    [router],
  );

  return (
    <OnboardingShell
      headerAction={
        <Link
          href="/login"
          className="text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Already have an account? Sign in
        </Link>
      }
    >
      <p className="mb-4 text-xs font-mono uppercase tracking-[0.22em] text-emerald-400/80">
        Get started
      </p>
      <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl lg:text-5xl">
        How will you use PymtHouse?
      </h1>
      <div className="mt-10 sm:mt-12">
        <PersonaStep busy={busy} highlight={highlight} onSelect={onSelect} />
      </div>
      <p className="mt-10 max-w-xl text-sm text-zinc-500">
        Next you&apos;ll create a wallet or sign in — then we mint your key.
        Existing accounts: use{" "}
        <Link href="/login" className="text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline">
          Sign in
        </Link>
        .
      </p>
    </OnboardingShell>
  );
}
