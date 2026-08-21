import { Suspense } from "react";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/next-auth-options";
import { developerNeedsOnboarding } from "@/lib/onboarding";
import StartPreview from "@/components/onboarding/StartPreview";

export const dynamic = "force-dynamic";

/**
 * Public onboarding preview (no account required).
 * Choice → Turnkey `/login` → resume `/onboarding?persona=…`.
 * Existing users keep `/login` for plain sign-in.
 */
export default async function StartPage() {
  const session = await getServerSession(authOptions);
  if (session?.user) {
    const userId = (session.user as Record<string, unknown>).id as string;
    const role = (session.user as Record<string, unknown>).role as
      | string
      | undefined;
    if (role === "admin" || role === "operator") {
      redirect("/apps");
    }
    if (await developerNeedsOnboarding(userId)) {
      redirect("/onboarding");
    }
    redirect("/apps");
  }

  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-500">
          Loading…
        </div>
      }
    >
      <StartPreview />
    </Suspense>
  );
}
