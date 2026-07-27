import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Full-viewport chrome for first-run onboarding (/start preview + /onboarding).
 * Brand-first, atmospheric — not a narrow settings form.
 */
export default function OnboardingShell({
  children,
  footer,
}: Readonly<{
  children: ReactNode;
  footer?: ReactNode;
}>) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(16,185,129,0.14),transparent_55%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_40%_at_80%_100%,rgba(20,184,166,0.08),transparent_50%)]"
      />

      <header className="relative z-10 px-6 pt-6 sm:px-10 sm:pt-8">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <Link
            href="/"
            className="text-lg font-semibold tracking-tight hover:opacity-90 transition-opacity sm:text-xl"
          >
            <span className="text-emerald-400">pymt</span>
            <span className="text-zinc-100">house</span>
          </Link>
          {footer}
        </div>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-5xl flex-col justify-center px-6 pb-16 pt-10 sm:px-10 sm:pb-24 sm:pt-16">
        {children}
      </main>
    </div>
  );
}
