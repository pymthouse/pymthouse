import { Suspense } from "react";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/next-auth-options";
import { developerNeedsOnboarding, getOnboardingStatus } from "@/lib/onboarding";
import type { OnboardingPersona } from "@/lib/onboarding-types";
import { isOnboardingPersona } from "@/lib/onboarding-intent";
import OnboardingShell from "@/components/onboarding/OnboardingShell";
import OnboardingWizard from "@/components/onboarding/OnboardingWizard";

export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ resume?: string; persona?: string }>;
}>) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    const params = await searchParams;
    const persona = isOnboardingPersona(params.persona) ? params.persona : null;
    const callback = persona
      ? `/onboarding?persona=${persona}`
      : "/onboarding";
    redirect(`/login?callbackUrl=${encodeURIComponent(callback)}`);
  }

  const userId = (session.user as Record<string, unknown>).id as string;
  const role = (session.user as Record<string, unknown>).role as string | undefined;
  if (role === "admin" || role === "operator") {
    redirect("/apps");
  }

  const params = await searchParams;
  const resumeBuilder = params.resume === "builder";
  const preferredPersona: OnboardingPersona | null = isOnboardingPersona(
    params.persona,
  )
    ? params.persona
    : null;
  const status = await getOnboardingStatus(userId);

  if (!resumeBuilder && !(await developerNeedsOnboarding(userId))) {
    redirect("/apps");
  }

  const initialPersona: OnboardingPersona | null =
    status.persona === "explorer" || status.persona === "builder"
      ? status.persona
      : null;

  return (
    <OnboardingShell>
      <Suspense
        fallback={<div className="text-sm text-zinc-500">Loading…</div>}
      >
        <OnboardingWizard
          initialPersona={resumeBuilder ? "builder" : initialPersona}
          resumeBuilder={resumeBuilder}
          preferredPersona={preferredPersona}
        />
      </Suspense>
    </OnboardingShell>
  );
}
