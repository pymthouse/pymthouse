import type { OnboardingPersona } from "@/lib/onboarding-types";

export const ONBOARDING_INTENT_KEY = "pymthouse.onboardingIntent";

export function isOnboardingPersona(
  value: string | null | undefined,
): value is OnboardingPersona {
  return value === "explorer" || value === "builder";
}

/** Persist persona chosen on the public /start preview (survives Turnkey hops). */
export function storeOnboardingIntent(persona: OnboardingPersona): void {
  try {
    sessionStorage.setItem(ONBOARDING_INTENT_KEY, persona);
  } catch {
    /* private mode / blocked storage — URL callback still works */
  }
}

/** Read and clear a stored intent. */
export function consumeOnboardingIntent(): OnboardingPersona | null {
  try {
    const value = sessionStorage.getItem(ONBOARDING_INTENT_KEY);
    sessionStorage.removeItem(ONBOARDING_INTENT_KEY);
    return isOnboardingPersona(value) ? value : null;
  } catch {
    return null;
  }
}

/** Post-auth resume target after picking a path on /start. */
export function onboardingResumePath(persona: OnboardingPersona): string {
  return `/onboarding?persona=${persona}`;
}

/** Turnkey login with callback that resumes the chosen path. */
export function loginUrlForPersona(persona: OnboardingPersona): string {
  return `/login?callbackUrl=${encodeURIComponent(onboardingResumePath(persona))}`;
}
