import { Suspense } from "react";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/next-auth-options";
import { VerifyEmailForm } from "./verify-email-form";

export const dynamic = "force-dynamic";

export default async function VerifyEmailPage() {
  const session = await getServerSession(authOptions);
  const user = session?.user as { id?: string; email?: string | null } | undefined;
  if (!user?.id) redirect("/login");
  const email = user.email?.trim().toLowerCase() ?? "";
  if (email && !email.endsWith("@turnkey.local")) {
    redirect("/onboarding");
  }
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-500">
          Loading…
        </div>
      }
    >
      <VerifyEmailForm />
    </Suspense>
  );
}
