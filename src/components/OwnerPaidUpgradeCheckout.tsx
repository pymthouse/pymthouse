"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import DashboardLayout from "@/components/DashboardLayout";
import { formatUsdMicrosSummary } from "@/lib/format-usd-micros";
import { stripeCheckoutRedirectUrl } from "@/lib/openmeter/stripe-checkout-session";

type OwnerTier = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  monthlyFeeUsd: string;
  includedUsdMicros: string;
};

export type UpgradePaymentMethodSummary = {
  brand: string | null;
  last4: string | null;
  type: string;
};

type ErrorCode =
  | "payment_method_required"
  | "openmeter_unavailable"
  | "no_subscription"
  | "confirm_required"
  | "tier_unavailable"
  | "upgrade_in_progress"
  | "upgrade_failed"
  | "already_subscribed"
  | "plan_unavailable"
  | "account_ineligible"
  | "rate_limited"
  | "network"
  | "unknown";

type ErrorSpec = { message: string; action?: string };

const ERROR_COPY: Record<ErrorCode, ErrorSpec> = {
  payment_method_required: {
    message: "A payment method is required to start a paid plan.",
    action: "Link a card, then confirm.",
  },
  openmeter_unavailable: {
    message: "Billing service temporarily unreachable.",
    action: "Try again in a moment. Your card was not charged.",
  },
  no_subscription: {
    message: "No active subscription found on this account.",
    action: "Contact support if this is unexpected.",
  },
  confirm_required: {
    message: "Upgrade requires explicit confirmation.",
    action: "Select a plan and press Confirm.",
  },
  tier_unavailable: {
    message: "The selected plan is no longer available.",
    action: "Choose another plan.",
  },
  upgrade_in_progress: {
    message: "An upgrade is already in progress for this account.",
    action: "Wait a moment, then refresh.",
  },
  upgrade_failed: {
    message: "Upgrade could not be completed.",
    action: "Try again. If this repeats, contact support.",
  },
  already_subscribed: {
    message: "This account is already on a paid plan.",
    action: "Go to billing to manage your plan.",
  },
  plan_unavailable: {
    message: "This plan is no longer offered or the price has changed.",
    action: "Reload the page to see current plans.",
  },
  account_ineligible: {
    message: "This account is not eligible for an upgrade at this time.",
    action: "Contact support for details.",
  },
  rate_limited: {
    message: "Too many requests. Please wait before trying again.",
  },
  network: {
    message: "Network error — your card was not charged.",
    action: "Check your connection and try again.",
  },
  unknown: {
    message: "Something went wrong.",
    action: "Try again or contact support at billing@pymthouse.com.",
  },
};

function classifyError(raw: string | undefined): ErrorCode {
  const msg = (raw ?? "").toLowerCase();
  if (msg.includes("payment_method_required")) return "payment_method_required";
  if (msg.includes("openmeter_unavailable")) return "openmeter_unavailable";
  if (msg.includes("no_subscription")) return "no_subscription";
  if (msg.includes("confirm_required")) return "confirm_required";
  if (msg.includes("tier_unavailable") || msg.includes("plan_unavailable")) {
    return "tier_unavailable";
  }
  if (msg.includes("upgrade_in_progress")) return "upgrade_in_progress";
  if (msg.includes("upgrade_failed")) return "upgrade_failed";
  if (msg.includes("already_subscribed") || msg.includes("already on")) {
    return "already_subscribed";
  }
  if (msg.includes("rate limit") || msg.includes("429")) return "rate_limited";
  if (msg.includes("failed to fetch") || msg.includes("network")) return "network";
  return "unknown";
}

/** Client idempotency token — crypto UUID, not Math.random (Sonar S2245). */
function makeIdempotencyKey(planKey: string): string {
  return `owner-upgrade:${planKey}:${crypto.randomUUID()}`;
}

function paymentMethodLabel(pm: UpgradePaymentMethodSummary): string {
  const brand =
    pm.brand?.trim() ||
    pm.type
      .replaceAll("_", " ")
      .replaceAll(/\b\w/g, (c) => c.toUpperCase());
  if (pm.last4) return `${brand} ···· ${pm.last4}`;
  return brand;
}

function billingDateLabel(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function tierHasSurplusIncludedUsage(tier: OwnerTier): boolean {
  const included = Number.parseFloat(
    formatUsdMicrosSummary(tier.includedUsdMicros).replaceAll("$", ""),
  );
  const fee = Number.parseFloat(tier.monthlyFeeUsd);
  return included > fee;
}

function confirmBlockingHint(
  planStepDone: boolean,
  cardStepDone: boolean,
): string {
  if (!planStepDone) return "Select a plan to continue.";
  if (!cardStepDone) return "Link a payment method to continue.";
  return "";
}

function confirmButtonLabel(
  busy: boolean,
  selected: OwnerTier | null,
): string {
  if (busy) return "Upgrading…";
  if (selected) return `Confirm — charge $${selected.monthlyFeeUsd} today`;
  return "Confirm upgrade";
}

function SkeletonRow() {
  return <div className="h-16 animate-pulse rounded-lg bg-white/4" />;
}

function StepBadge({ n, done }: Readonly<{ n: number; done?: boolean }>) {
  return (
    <span
      className={[
        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
        done ? "bg-emerald-500/25 text-emerald-400" : "bg-white/8 text-zinc-400",
      ].join(" ")}
      aria-hidden="true"
    >
      {done ? (
        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none">
          <path
            d="M2 6l3 3 5-5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        n
      )}
    </span>
  );
}

function CardIcon({ type }: Readonly<{ type: string }>) {
  const t = type.toLowerCase();
  if (t.includes("visa")) {
    return (
      <svg viewBox="0 0 38 24" className="h-4 w-6 shrink-0" aria-hidden="true">
        <rect width="38" height="24" rx="3" fill="#1A1F71" />
        <path
          d="M16 7l-3 10h-2L8 9.5c-.2-.6-.4-.8-.8-1A6.5 6.5 0 005 8l.1-.5h3.2c.4 0 .8.3.9.7l.8 4.3 2.1-5zm1.8 0h2l-1.5 10h-2zm8 6.5c0-1.7-2.4-1.8-2.4-2.6 0-.2.2-.5.8-.6.5 0 1 .1 1.4.3l.3-1.3A4 4 0 0024.5 9c-2.1 0-3.5 1.1-3.5 2.7 0 1.2 1 1.8 1.8 2.2.8.4 1 .7 1 1s-.4 1-1.2 1c-.7 0-1.4-.2-2-.5l-.3 1.3c.6.3 1.3.4 2 .4 2.2 0 3.5-1 3.5-2.6zm5-6.5l-3 10h-2l3-10h2z"
          fill="white"
        />
      </svg>
    );
  }
  if (t.includes("mastercard")) {
    return (
      <svg viewBox="0 0 38 24" className="h-4 w-6 shrink-0" aria-hidden="true">
        <rect width="38" height="24" rx="3" fill="#252525" />
        <circle cx="15" cy="12" r="7" fill="#EB001B" />
        <circle cx="23" cy="12" r="7" fill="#F79E1B" />
        <path
          d="M19 7.3A7 7 0 0122.6 12 7 7 0 0119 16.7 7 7 0 0115.4 12 7 7 0 0119 7.3z"
          fill="#FF5F00"
        />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-5 shrink-0 text-zinc-400"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="2"
        y="5"
        width="20"
        height="14"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M2 10h20" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

function ErrorBanner({
  code,
}: Readonly<{ code: ErrorCode; raw?: string }>) {
  const spec = ERROR_COPY[code];
  const detail = spec.action
    ? `${spec.message} ${spec.action}`
    : spec.message;
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="mb-6 flex gap-3 rounded-lg border border-red-500/25 bg-red-500/8 px-4 py-3"
    >
      <svg
        viewBox="0 0 20 20"
        className="mt-0.5 h-4 w-4 shrink-0 text-red-400"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
          clipRule="evenodd"
        />
      </svg>
      <p className="text-sm text-red-300">{detail}</p>
    </div>
  );
}

function NoticeBanner({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-6 flex gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.07] px-4 py-3"
    >
      <svg
        viewBox="0 0 20 20"
        className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
          clipRule="evenodd"
        />
      </svg>
      <p className="text-sm text-emerald-300">{children}</p>
    </div>
  );
}

const PLAN_DETAIL: Record<string, { headline: string; bullets: string[] }> = {
  pymthouse_owner_paid: {
    headline: "Full network access for production apps",
    bullets: [
      "5 USD included usage — roughly 5 M API calls at standard rate",
      "Unlimited developer identities and API keys",
      "Overage billed per-call, no monthly cap",
    ],
  },
  pymthouse_producer: {
    headline: "Paid-tier access for building and testing",
    bullets: [
      "3 USD included usage — roughly 3 M API calls",
      "Monetisation features available immediately",
      "Designed for pre-launch and monetisation testing",
    ],
  },
};

function getPlanDetail(key: string) {
  for (const [prefix, detail] of Object.entries(PLAN_DETAIL)) {
    if (key.startsWith(prefix)) return detail;
  }
  return null;
}

function TierDescription({
  tier,
  detail,
}: Readonly<{
  tier: OwnerTier;
  detail: { headline: string; bullets: string[] } | null;
}>) {
  if (detail) {
    return (
      <ul className="mt-2 space-y-0.5">
        {detail.bullets.map((b) => (
          <li
            key={b}
            className="flex items-start gap-1.5 text-xs text-zinc-400"
          >
            <span className="mt-0.5 text-emerald-500/70" aria-hidden="true">
              ·
            </span>
            {b}
          </li>
        ))}
      </ul>
    );
  }
  if (tier.description) {
    return (
      <p className="mt-1.5 text-xs text-zinc-400">{tier.description}</p>
    );
  }
  return (
    <p className="mt-1.5 text-xs text-zinc-400">
      {formatUsdMicrosSummary(tier.includedUsdMicros)} included usage each
      billing cycle. Overage billed to your card.
    </p>
  );
}

function TierCard({
  tier,
  selected,
  onSelect,
  disabled,
  inputName,
}: Readonly<{
  tier: OwnerTier;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  inputName: string;
}>) {
  const detail = getPlanDetail(tier.key);
  return (
    <label
      className={[
        "group relative flex cursor-pointer flex-col gap-2 rounded-xl border px-4 py-4 transition-all",
        "focus-within:ring-2 focus-within:ring-emerald-500/60 focus-within:ring-offset-1 focus-within:ring-offset-transparent",
        selected
          ? "border-emerald-500/50 bg-emerald-500/[0.07]"
          : "border-white/[0.07] bg-white/[0.025] hover:border-white/15",
        disabled ? "pointer-events-none opacity-50" : "",
      ].join(" ")}
    >
      <input
        type="radio"
        name={inputName}
        value={tier.key}
        checked={selected}
        onChange={onSelect}
        disabled={disabled}
        className="sr-only"
      />
      <div className="flex items-start justify-between gap-4">
        <span
          className={[
            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
            selected
              ? "border-emerald-500 bg-emerald-500/20"
              : "border-zinc-600 bg-transparent",
          ].join(" ")}
          aria-hidden="true"
        >
          {selected ? (
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          ) : null}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-medium text-zinc-100">{tier.name}</span>
            {detail ? (
              <span className="text-xs text-zinc-500">{detail.headline}</span>
            ) : null}
          </div>
          <TierDescription tier={tier} detail={detail} />
        </div>
        <div className="shrink-0 text-right">
          <span className="text-lg font-semibold text-emerald-300">
            ${tier.monthlyFeeUsd}
          </span>
          <span className="block text-xs text-zinc-500">/month</span>
        </div>
      </div>
    </label>
  );
}

function OrderSummary({
  selected,
  paymentMethod,
  hasPaymentMethod,
}: Readonly<{
  selected: OwnerTier | null;
  paymentMethod: UpgradePaymentMethodSummary | null;
  hasPaymentMethod: boolean;
}>) {
  if (!selected) return null;
  return (
    <div className="rounded-xl border border-white/6 bg-white/2.5 p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
        Order summary
      </p>
      <div className="mt-3 space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm text-zinc-300">{selected.name}</span>
          <span className="text-sm font-medium text-zinc-100">
            ${selected.monthlyFeeUsd}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2 text-xs text-zinc-500">
          <span>Included usage</span>
          <span>
            {formatUsdMicrosSummary(selected.includedUsdMicros)} value
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2 text-xs text-zinc-500">
          <span>Overage</span>
          <span>Billed per-call after included</span>
        </div>
      </div>
      <div className="my-3 border-t border-white/6" />
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-zinc-200">Charged today</span>
        <span className="font-semibold text-zinc-100">
          ${selected.monthlyFeeUsd}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Billing cycle starts {billingDateLabel()}. Next invoice on the same date
        next month.
      </p>
      {hasPaymentMethod && paymentMethod ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
          <CardIcon type={paymentMethod.type} />
          <span>{paymentMethodLabel(paymentMethod)}</span>
        </div>
      ) : null}
    </div>
  );
}

function TrustBar() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-600">
      <span className="flex items-center gap-1.5">
        <svg
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5 shrink-0"
          fill="none"
          aria-hidden="true"
        >
          <rect
            x="3"
            y="7"
            width="10"
            height="7"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path
            d="M5.5 7V5a2.5 2.5 0 015 0v2"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
        Secured by Stripe — we never store your card details.
      </span>
      <span>Cancel anytime from billing settings.</span>
      <a
        href="mailto:billing@pymthouse.com"
        className="underline-offset-2 hover:text-zinc-400 hover:underline"
      >
        Questions? billing@pymthouse.com
      </a>
    </div>
  );
}

function PlanPicker({
  loadingTiers,
  tiers,
  selectedKey,
  busy,
  radioGroupId,
  onSelectTier,
}: Readonly<{
  loadingTiers: boolean;
  tiers: OwnerTier[];
  selectedKey: string;
  busy: boolean;
  radioGroupId: string;
  onSelectTier: (key: string) => void;
}>) {
  if (loadingTiers) {
    return (
      <div className="space-y-2" aria-label="Loading plans">
        <SkeletonRow />
        <SkeletonRow />
      </div>
    );
  }
  if (tiers.length === 0) {
    return (
      <p className="rounded-lg border border-amber-500/20 bg-amber-500/[0.07] px-4 py-3 text-sm text-amber-300">
        No paid plans are configured. Contact a platform admin.
      </p>
    );
  }
  return (
    <>
      {tiers.some(tierHasSurplusIncludedUsage) ? (
        <p className="mb-3 text-xs text-zinc-600">
          Included usage on entry plans covers testing; production throughput
          scales with the full plan.
        </p>
      ) : null}
      <div
        role="radiogroup"
        aria-labelledby="step-plan-heading"
        id={radioGroupId}
        className="space-y-2"
      >
        {tiers.map((tier) => (
          <TierCard
            key={tier.id}
            tier={tier}
            selected={tier.key === selectedKey}
            onSelect={() => onSelectTier(tier.key)}
            disabled={busy}
            inputName={radioGroupId}
          />
        ))}
      </div>
    </>
  );
}

function PaymentMethodStep({
  hasPaymentMethod,
  paymentMethod,
  pmBusy,
  busy,
  onLink,
}: Readonly<{
  hasPaymentMethod: boolean;
  paymentMethod: UpgradePaymentMethodSummary | null;
  pmBusy: boolean;
  busy: boolean;
  onLink: () => void;
}>) {
  if (hasPaymentMethod && paymentMethod) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/6 bg-white/2.5 px-4 py-3">
        <div className="flex items-center gap-2.5 text-sm text-zinc-200">
          <CardIcon type={paymentMethod.type} />
          <span>{paymentMethodLabel(paymentMethod)}</span>
        </div>
        <button
          type="button"
          className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-white/20 hover:text-zinc-200 disabled:pointer-events-none disabled:opacity-40"
          disabled={pmBusy || busy}
          onClick={onLink}
        >
          {pmBusy ? "Opening Stripe…" : "Replace card"}
        </button>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-white/6 bg-white/2.5 px-4 py-4">
      <p className="text-sm text-zinc-400">No payment method on file.</p>
      <p className="mt-0.5 text-xs text-zinc-600">
        Adding a card does not charge you. You confirm the charge in the next
        step.
      </p>
      <button
        type="button"
        className="mt-3 inline-flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-300 transition-colors hover:border-emerald-500/60 hover:bg-emerald-500/15 disabled:pointer-events-none disabled:opacity-50"
        disabled={pmBusy || busy}
        onClick={onLink}
      >
        {pmBusy ? (
          <>
            <Spinner />
            Opening Stripe…
          </>
        ) : (
          <>
            <svg
              viewBox="0 0 16 16"
              className="h-3.5 w-3.5"
              fill="none"
              aria-hidden="true"
            >
              <rect
                x="1"
                y="4"
                width="14"
                height="9"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <path d="M1 7.5h14" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            Link payment method via Stripe
          </>
        )}
      </button>
    </div>
  );
}

function ConfirmActions({
  canConfirm,
  busy,
  planStepDone,
  cardStepDone,
  selected,
  confirmRegionId,
  onConfirm,
}: Readonly<{
  canConfirm: boolean;
  busy: boolean;
  planStepDone: boolean;
  cardStepDone: boolean;
  selected: OwnerTier | null;
  confirmRegionId: string;
  onConfirm: () => void;
}>) {
  const hint = confirmBlockingHint(planStepDone, cardStepDone);
  return (
    <div
      id={confirmRegionId}
      aria-live="polite"
      aria-busy={busy}
      className="flex flex-wrap items-center justify-between gap-3 pt-2"
    >
      {!canConfirm && !busy && hint ? (
        <p className="text-xs text-zinc-600">{hint}</p>
      ) : null}
      {busy ? (
        <p className="flex items-center gap-1.5 text-xs text-zinc-500">
          <Spinner />
          Upgrading — do not close this tab.
        </p>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-2">
        <Link
          href="/billing"
          className="rounded-md px-3 py-2 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
          aria-disabled={busy}
          tabIndex={busy ? -1 : 0}
        >
          Cancel
        </Link>
        <button
          type="button"
          className={[
            "inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold transition-all",
            canConfirm
              ? "bg-emerald-500 text-black hover:bg-emerald-400 active:scale-[0.98]"
              : "cursor-not-allowed bg-zinc-700/60 text-zinc-500",
          ].join(" ")}
          disabled={!canConfirm}
          onClick={onConfirm}
          aria-describedby={confirmRegionId}
        >
          {busy ? <Spinner /> : null}
          {confirmButtonLabel(busy, selected)}
        </button>
      </div>
    </div>
  );
}

export default function OwnerPaidUpgradeCheckout({
  hasPaymentMethod,
  paymentMethod,
  initialPlanKey,
  pmAttached,
}: Readonly<{
  hasPaymentMethod: boolean;
  paymentMethod: UpgradePaymentMethodSummary | null;
  initialPlanKey: string | null;
  pmAttached: boolean;
}>) {
  const router = useRouter();
  const radioGroupId = useId();
  const confirmRegionId = useId();

  const [tiers, setTiers] = useState<OwnerTier[]>([]);
  const [selectedKey, setSelectedKey] = useState(initialPlanKey ?? "");
  const [loadingTiers, setLoadingTiers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pmBusy, setPmBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<ErrorCode | null>(null);
  const [notice, setNotice] = useState<string | null>(
    pmAttached
      ? "Payment method saved. Select a plan and press Confirm to finish."
      : null,
  );

  const idempotencyKeyRef = useRef(makeIdempotencyKey(initialPlanKey ?? ""));
  const lastKeyedPlanRef = useRef(initialPlanKey ?? "");

  function setSelectedKeyWithRotate(key: string) {
    setSelectedKey(key);
    if (key !== lastKeyedPlanRef.current) {
      idempotencyKeyRef.current = makeIdempotencyKey(key);
      lastKeyedPlanRef.current = key;
    }
  }

  useEffect(() => {
    if (!busy) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [busy]);

  useEffect(() => {
    if (!busy) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [busy]);

  const loadTiers = useCallback(async () => {
    setLoadingTiers(true);
    setErrorCode(null);
    try {
      const res = await fetch("/api/v1/me/billing/owner-tiers");
      const body = (await res.json().catch(() => ({}))) as {
        tiers?: OwnerTier[];
        error?: string;
      };
      if (!res.ok) throw new Error(body.error || "Could not load plans");
      const list = body.tiers ?? [];
      setTiers(list);
      setSelectedKey((prev) => {
        if (prev && list.some((t) => t.key === prev)) return prev;
        const first = list[0]?.key || "";
        if (first && first !== lastKeyedPlanRef.current) {
          idempotencyKeyRef.current = makeIdempotencyKey(first);
          lastKeyedPlanRef.current = first;
        }
        return first;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorCode(classifyError(msg));
    } finally {
      setLoadingTiers(false);
    }
  }, []);

  useEffect(() => {
    void loadTiers();
  }, [loadTiers]);

  useEffect(() => {
    if (!pmAttached) return;
    const plan = selectedKey || initialPlanKey;
    const next = plan
      ? `/billing/upgrade?plan=${encodeURIComponent(plan)}`
      : "/billing/upgrade";
    router.replace(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot pm return
  }, [pmAttached, router]);

  const selected = tiers.find((t) => t.key === selectedKey) ?? null;
  const planStepDone = selected !== null;
  const cardStepDone = hasPaymentMethod;
  const canConfirm = planStepDone && cardStepDone && !busy;

  function upgradeUrlWithPlan(extra: Record<string, string> = {}): string {
    const url = new URL("/billing/upgrade", window.location.origin);
    if (selectedKey) url.searchParams.set("plan", selectedKey);
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    return url.toString();
  }

  async function startPaymentMethodCheckout() {
    setPmBusy(true);
    setErrorCode(null);
    setNotice(null);
    try {
      const res = await fetch("/api/v1/me/billing/payment-method", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          successUrl: upgradeUrlWithPlan({ pm: "attached" }),
          cancelUrl: upgradeUrlWithPlan(),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        checkoutUrl?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error || "Could not start Stripe Checkout");
      const checkoutUrl = stripeCheckoutRedirectUrl(body.checkoutUrl ?? "");
      if (
        !checkoutUrl ||
        !/^https:\/\/([a-z0-9-]+\.)?checkout\.stripe\.com\//i.test(checkoutUrl)
      ) {
        throw new Error("Checkout URL missing or invalid");
      }
      window.location.assign(checkoutUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorCode(classifyError(msg));
      setPmBusy(false);
    }
  }

  async function confirmUpgrade() {
    if (!selected || !hasPaymentMethod || busy) return;
    setBusy(true);
    setErrorCode(null);
    setNotice(null);
    try {
      const res = await fetch("/api/v1/me/billing/upgrade-paid", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKeyRef.current,
        },
        body: JSON.stringify({ planKey: selected.key, confirm: true }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setErrorCode(classifyError(body.error || "Upgrade failed"));
        setBusy(false);
        return;
      }
      router.push("/billing?upgraded=1");
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorCode(classifyError(msg));
      setBusy(false);
    }
  }

  function onSelectTier(key: string) {
    setSelectedKeyWithRotate(key);
    router.replace(`/billing/upgrade?plan=${encodeURIComponent(key)}`);
  }

  return (
    <DashboardLayout>
      <div className="mb-8">
        <Link
          href="/billing"
          className="inline-flex items-center gap-1 text-xs text-zinc-600 transition-colors hover:text-zinc-300"
        >
          <svg
            viewBox="0 0 16 16"
            className="h-3.5 w-3.5"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M10 12L6 8l4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Billing
        </Link>
        <h1 className="mt-3 text-xl font-semibold text-zinc-100 sm:text-2xl">
          Upgrade your plan
        </h1>
        <p className="mt-1.5 text-sm text-zinc-500">
          Pick a plan and confirm. Your card is not charged until you press
          Confirm — linking it here does not subscribe you.
        </p>
      </div>

      {notice ? <NoticeBanner>{notice}</NoticeBanner> : null}
      {errorCode ? <ErrorBanner code={errorCode} /> : null}

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
        <div className="min-w-0 flex-1 space-y-5">
          <section aria-labelledby="step-plan-heading">
            <div className="mb-3 flex items-center gap-2">
              <StepBadge n={1} done={planStepDone} />
              <h2
                id="step-plan-heading"
                className="text-sm font-semibold text-zinc-200"
              >
                Choose a plan
              </h2>
            </div>
            <PlanPicker
              loadingTiers={loadingTiers}
              tiers={tiers}
              selectedKey={selectedKey}
              busy={busy}
              radioGroupId={radioGroupId}
              onSelectTier={onSelectTier}
            />
          </section>

          <section aria-labelledby="step-pm-heading">
            <div className="mb-3 flex items-center gap-2">
              <StepBadge n={2} done={cardStepDone} />
              <h2
                id="step-pm-heading"
                className="text-sm font-semibold text-zinc-200"
              >
                Payment method
              </h2>
            </div>
            <PaymentMethodStep
              hasPaymentMethod={hasPaymentMethod}
              paymentMethod={paymentMethod}
              pmBusy={pmBusy}
              busy={busy}
              onLink={() => void startPaymentMethodCheckout()}
            />
          </section>

          <div className="block lg:hidden">
            <OrderSummary
              selected={selected}
              paymentMethod={paymentMethod}
              hasPaymentMethod={hasPaymentMethod}
            />
          </div>

          <ConfirmActions
            canConfirm={canConfirm}
            busy={busy}
            planStepDone={planStepDone}
            cardStepDone={cardStepDone}
            selected={selected}
            confirmRegionId={confirmRegionId}
            onConfirm={() => void confirmUpgrade()}
          />

          <TrustBar />
        </div>

        <aside className="hidden w-64 shrink-0 lg:block">
          <div className="sticky top-6">
            <OrderSummary
              selected={selected}
              paymentMethod={paymentMethod}
              hasPaymentMethod={hasPaymentMethod}
            />
            {!loadingTiers && tiers.length >= 2 ? (
              <div className="mt-4 rounded-lg border border-white/5 bg-white/1.5 px-3 py-3 text-xs text-zinc-600">
                <p className="font-medium text-zinc-500">About the plans</p>
                <p className="mt-1">
                  Entry plans include more usage than they cost — that&apos;s
                  intentional. The production plan provides higher throughput
                  limits and priority routing.
                </p>
              </div>
            ) : null}
          </div>
        </aside>
      </div>
    </DashboardLayout>
  );
}
