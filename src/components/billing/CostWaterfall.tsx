import {
  formatUsdMicrosExactTitle,
  formatUsdMicrosSummary,
} from "@/lib/format-usd-micros";
import {
  buildCostWaterfall,
  formatPaymentMethodLabel,
} from "@/lib/billing/cost-waterfall";

function StepRow({
  connector,
  label,
  amountUsdMicros,
  note,
  muted,
  emphasize,
}: Readonly<{
  connector: string;
  label: string;
  amountUsdMicros: string;
  note?: string | null;
  muted?: boolean;
  /** Hard pressure state (needs payment method) — amber, not muted. */
  emphasize?: boolean;
}>) {
  let labelClass = "text-zinc-300";
  let amountClass = "text-zinc-200";
  let noteClass = "text-zinc-600";
  if (emphasize) {
    labelClass = "text-amber-300";
    amountClass = "text-amber-200";
    noteClass = "text-amber-500/90";
  } else if (muted) {
    labelClass = "text-zinc-500";
    amountClass = "text-zinc-500";
  }

  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5">
      <span aria-hidden className="font-mono text-xs text-zinc-700">
        {connector}
      </span>
      <span className={`text-xs ${labelClass}`}>{label}</span>
      <span
        className={`ml-auto font-mono text-xs tabular-nums ${amountClass}`}
        title={formatUsdMicrosExactTitle(amountUsdMicros)}
      >
        {formatUsdMicrosSummary(amountUsdMicros)}
      </span>
      {note ? (
        <span className={`w-full pl-6 text-[11px] sm:w-auto sm:pl-0 ${noteClass}`}>
          {note}
        </span>
      ) : null}
    </li>
  );
}

function cardStepCopy(input: {
  cardLabel: string | null;
  cardAppliedUsdMicros: string;
  needsPaymentMethod: boolean;
}): { label: string; note: string | null; muted: boolean; emphasize: boolean } {
  if (input.cardLabel) {
    return {
      label: `Charged to ${input.cardLabel}`,
      note: null,
      muted: false,
      emphasize: false,
    };
  }
  const hasOverage = (() => {
    try {
      return BigInt(input.cardAppliedUsdMicros) > 0n;
    } catch {
      return false;
    }
  })();
  if (input.needsPaymentMethod || hasOverage) {
    return {
      label: "Needs payment method",
      note: hasOverage
        ? "Usage paused — attach a card to continue"
        : "Attach a payment method for plan fee & overage",
      muted: false,
      emphasize: true,
    };
  }
  return {
    label: "Charged to card",
    note: "No payment method attached",
    muted: true,
    emphasize: false,
  };
}

/**
 * Renders the cycle's spend in the order it is actually settled — plan
 * allowance, then prepaid credits, then the card — so the figures on the
 * page reconcile against the total without explanatory prose.
 */
export default function CostWaterfall({
  usedUsdMicros,
  planIncludedUsdMicros,
  creditBalanceUsdMicros,
  paymentMethod,
  needsPaymentMethod = false,
  className,
}: Readonly<{
  usedUsdMicros: string | null | undefined;
  planIncludedUsdMicros?: string | null;
  creditBalanceUsdMicros?: string | null;
  paymentMethod?: { brand?: string | null; last4?: string | null } | null;
  /**
   * Owner is cardless and spendable is exhausted (or would settle on card).
   * Switches the card row from a soft note to a blocked-state label.
   */
  needsPaymentMethod?: boolean;
  className?: string;
}>) {
  const waterfall = buildCostWaterfall({
    usedUsdMicros,
    planIncludedUsdMicros,
    creditBalanceUsdMicros,
  });

  const cardLabel = formatPaymentMethodLabel(paymentMethod);
  const cardCopy = cardStepCopy({
    cardLabel,
    cardAppliedUsdMicros: waterfall.card.appliedUsdMicros,
    needsPaymentMethod,
  });
  const planNote = waterfall.plan.capacityUsdMicros
    ? `${formatUsdMicrosSummary(waterfall.plan.capacityUsdMicros)} included · ${formatUsdMicrosSummary(
        waterfall.plan.remainingUsdMicros,
      )} left`
    : null;
  const creditsNote = `${formatUsdMicrosSummary(waterfall.credits.remainingUsdMicros)} left`;

  return (
    <div className={className}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/[0.06] pb-2">
        <span className="text-xs font-medium text-zinc-300">Usage this cycle</span>
        <span
          className="font-mono text-sm tabular-nums text-zinc-100"
          title={formatUsdMicrosExactTitle(waterfall.usedUsdMicros)}
        >
          {formatUsdMicrosSummary(waterfall.usedUsdMicros)}
        </span>
      </div>

      <ul className="mt-1">
        {waterfall.hasPlanAllowance ? (
          <StepRow
            connector="├─"
            label="Covered by plan"
            amountUsdMicros={waterfall.plan.appliedUsdMicros}
            note={planNote}
          />
        ) : null}
        <StepRow
          connector="├─"
          label="From prepaid credits"
          amountUsdMicros={waterfall.credits.appliedUsdMicros}
          note={creditsNote}
        />
        <StepRow
          connector="└─"
          label={cardCopy.label}
          amountUsdMicros={waterfall.card.appliedUsdMicros}
          muted={cardCopy.muted}
          emphasize={cardCopy.emphasize}
          note={cardCopy.note}
        />
      </ul>
    </div>
  );
}
