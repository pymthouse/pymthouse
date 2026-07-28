"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { OnboardingPersona } from "@/lib/onboarding-types";
import {
  consumeOnboardingIntent,
  isOnboardingPersona,
} from "@/lib/onboarding-intent";
import PersonaStep from "@/components/onboarding/PersonaStep";
import BuilderCreateStep from "@/components/onboarding/BuilderCreateStep";
import CopyIdButton from "@/components/apps/CopyIdButton";
import ApiKeyCredentialSwitcher from "@/components/apps/ApiKeyCredentialSwitcher";
import { getDocsBaseUrl } from "@/lib/docs-base-url";

type WizardStep = "persona" | "builder" | "done";

type MintedKey = {
  clientId: string;
  apiKey: string;
  sdkToken: string | null;
};

const DOCS_ONBOARDING_HREF = getDocsBaseUrl();

async function postJson(path: string, body?: Record<string, unknown>) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message = [
      data.error_description,
      data.error,
      `Request failed (${res.status})`,
    ].find((v): v is string => typeof v === "string" && v.trim().length > 0);
    throw new Error(message ?? "Request failed");
  }
  return data;
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value : "";
}

export default function OnboardingWizard({
  initialPersona,
  resumeBuilder,
  preferredPersona,
}: Readonly<{
  initialPersona: OnboardingPersona | null;
  resumeBuilder: boolean;
  /** From /start → Turnkey → /onboarding?persona=… */
  preferredPersona?: OnboardingPersona | null;
}>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const resume = resumeBuilder || searchParams.get("resume") === "builder";
  const rawPersona = searchParams.get("persona");
  const urlPersona = isOnboardingPersona(rawPersona) ? rawPersona : null;

  const [step, setStep] = useState<WizardStep>(() => {
    if (resume || initialPersona === "builder") return "builder";
    return "persona";
  });
  const [persona, setPersona] = useState<OnboardingPersona | null>(initialPersona);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const autoResumeStarted = useRef(false);

  useEffect(() => {
    void fetch("/api/v1/onboarding/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: resume ? "onboarding_resumed" : "onboarding_started",
        step: resume ? "builder" : "persona",
        persona: persona ?? preferredPersona ?? urlPersona ?? null,
      }),
    }).catch(() => {
      /* best-effort */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);

  const title = useMemo(() => {
    switch (step) {
      case "persona":
        return "How will you use PymtHouse?";
      case "builder":
        return "Create your app";
      default:
        return "You're ready";
    }
  }, [step]);

  const subtitle = useMemo(() => {
    switch (step) {
      case "persona":
        return null;
      case "builder":
        return "Name your product — we'll mint a signing key next.";
      default:
        return null;
    }
  }, [step]);

  const selectPersona = useCallback(async (next: OnboardingPersona) => {
    setError(null);
    setBusy(true);
    try {
      await postJson("/api/v1/onboarding", { persona: next });
      setPersona(next);

      if (next === "builder") {
        setStep("builder");
        return;
      }

      const data = await postJson("/api/v1/network/key");
      setMinted({
        clientId: stringField(data, "clientId"),
        apiKey: stringField(data, "apiKey"),
        sdkToken: typeof data.sdkToken === "string" ? data.sdkToken : null,
      });
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not continue");
    } finally {
      setBusy(false);
    }
  }, []);

  // Resume path chosen on public /start after Turnkey (URL + sessionStorage).
  useEffect(() => {
    if (autoResumeStarted.current) return;
    if (step !== "persona") return;
    if (resume) return;

    const fromStorage = consumeOnboardingIntent();
    const next =
      preferredPersona ??
      urlPersona ??
      fromStorage ??
      null;
    if (!next) return;

    autoResumeStarted.current = true;
    void selectPersona(next);
  }, [step, resume, preferredPersona, urlPersona, selectPersona]);

  const softSkipBuilder = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await postJson("/api/v1/onboarding", {
        persona: "builder",
        softSkip: true,
      });
      router.push("/apps?setup=1");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not skip");
      setBusy(false);
    }
  }, [router]);

  const finishBuilder = useCallback(
    (clientId: string, apiKey: string | null, sdkToken: string | null) => {
      setPersona("builder");
      if (apiKey) {
        setMinted({ clientId, apiKey, sdkToken });
        setStep("done");
        return;
      }
      router.push(`/apps/${encodeURIComponent(clientId)}?tab=credentials`);
    },
    [router],
  );

  return (
    <div className="w-full">
      <p className="mb-4 text-xs font-mono uppercase tracking-[0.22em] text-emerald-400/80">
        Onboarding
      </p>
      <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl lg:text-5xl">
        {title}
      </h1>
      {subtitle && (
        <p className="mt-4 max-w-2xl text-base text-zinc-400 sm:text-lg">
          {subtitle}
        </p>
      )}

      <div className="mt-10 sm:mt-12">
        {error && (
          <div className="mb-6 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-300">
            {error}
          </div>
        )}

        {step === "persona" && (
          <PersonaStep
            busy={busy}
            highlight={preferredPersona ?? urlPersona}
            onSelect={(p) => void selectPersona(p)}
          />
        )}

        {step === "builder" && (
          <div className="max-w-xl">
            <BuilderCreateStep
              busy={busy}
              onCreated={finishBuilder}
              onSoftSkip={() => void softSkipBuilder()}
              onBack={resume ? undefined : () => setStep("persona")}
            />
          </div>
        )}

        {step === "done" && minted && (
          <div className="space-y-8">
            <div className="rounded-2xl border border-emerald-500/35 bg-gradient-to-br from-emerald-500/15 via-emerald-500/5 to-transparent p-6 sm:p-8">
              <p className="text-lg font-semibold text-emerald-300 sm:text-xl">
                You&apos;re ready to go!
              </p>
              <p className="mt-2 max-w-xl text-sm text-zinc-400 sm:text-base">
                Copy your API key now — it won&apos;t be shown again. This is
                your first call into the Livepeer network.
              </p>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div>
                <p className="mb-2 text-xs font-mono uppercase tracking-wider text-zinc-500">
                  Client ID
                </p>
                <div className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/80 px-4 py-3">
                  <code className="min-w-0 flex-1 break-all font-mono text-sm text-zinc-200">
                    {minted.clientId}
                  </code>
                  <CopyIdButton value={minted.clientId} label="Copy client ID" />
                </div>
              </div>
              <div className="lg:col-span-2">
                <p className="mb-2 text-xs font-mono uppercase tracking-wider text-zinc-500">
                  API key
                </p>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-4 sm:p-5">
                  <ApiKeyCredentialSwitcher
                    apiKey={minted.apiKey}
                    sdkToken={minted.sdkToken}
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-3 pt-2">
              <button
                type="button"
                onClick={() =>
                  router.push(
                    persona === "builder"
                      ? `/apps/${encodeURIComponent(minted.clientId)}`
                      : "/apps",
                  )
                }
                className="rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-500/20 hover:bg-emerald-500"
              >
                Continue to dashboard
              </button>
              <a
                href={DOCS_ONBOARDING_HREF}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-xl border border-zinc-700 px-6 py-3 text-sm font-medium text-zinc-300 hover:border-zinc-500"
              >
                Read the docs
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
