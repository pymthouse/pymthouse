"use client";

import type { OnboardingPersona } from "@/lib/onboarding-types";

export default function PersonaStep({
  busy,
  onSelect,
  highlight,
}: Readonly<{
  busy: boolean;
  onSelect: (persona: OnboardingPersona) => void;
  /** Optional path to emphasize (e.g. marketing deep link). */
  highlight?: OnboardingPersona | null;
}>) {
  return (
    <div className="space-y-8">
      <p className="max-w-2xl text-base text-zinc-400 sm:text-lg">
        You can change this later. If you&apos;re unsure, choose Explorer.
      </p>

      <div className="grid gap-5 sm:grid-cols-2 sm:gap-6">
        <PersonaCard
          persona="explorer"
          label="Explorer"
          title="Try the network"
          description="Personal projects and experiments. Get a key on the shared app and start signing."
          accent="emerald"
          busy={busy}
          highlighted={highlight === "explorer"}
          onSelect={onSelect}
        />
        <PersonaCard
          persona="builder"
          label="Builder"
          title="Ship a product"
          description="Your own app, keys, plans, and users — ready for customers."
          accent="teal"
          busy={busy}
          highlighted={highlight === "builder"}
          onSelect={onSelect}
        />
      </div>

      {busy && (
        <p className="text-sm text-zinc-500" aria-live="polite">
          Setting up…
        </p>
      )}
    </div>
  );
}

function PersonaCard({
  persona,
  label,
  title,
  description,
  accent,
  busy,
  highlighted,
  onSelect,
}: Readonly<{
  persona: OnboardingPersona;
  label: string;
  title: string;
  description: string;
  accent: "emerald" | "teal";
  busy: boolean;
  highlighted: boolean;
  onSelect: (persona: OnboardingPersona) => void;
}>) {
  const accentLabel =
    accent === "emerald" ? "text-emerald-400/90" : "text-teal-400/90";
  const accentBorder = highlighted
    ? accent === "emerald"
      ? "border-emerald-500/60 ring-1 ring-emerald-500/30"
      : "border-teal-500/60 ring-1 ring-teal-500/30"
    : "border-zinc-700/80 hover:border-emerald-500/45";

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onSelect(persona)}
      className={`group min-h-[11rem] text-left rounded-2xl border bg-zinc-900/50 p-6 sm:min-h-[13rem] sm:p-8 transition duration-200 ease-out hover:bg-zinc-900/80 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/40 motion-safe:hover:-translate-y-0.5 ${accentBorder}`}
    >
      <p
        className={`text-xs font-mono uppercase tracking-[0.2em] mb-3 ${accentLabel}`}
      >
        {label}
      </p>
      <p className="text-xl font-semibold text-zinc-50 sm:text-2xl">{title}</p>
      <p className="mt-3 text-sm leading-relaxed text-zinc-500 sm:text-base group-hover:text-zinc-400">
        {description}
      </p>
    </button>
  );
}
