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
}: Readonly<{
  connector: string;
  label: string;
  amountUsdMicros: string;
  note?: string | null;
  muted?: boolean;
}>) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5">
      <span aria-hidden className="font-mono text-xs text-zinc-700">
        {connector}
      </span>
      <span className={`text-xs ${muted ? "text-zinc-500" : "text-zinc-300"}`}>
        {label}
      </span>
      <span
        className={`ml-auto font-mono text-xs tabular-nums ${
          muted ? "text-zinc-500" : "text-zinc-200"
        }`}
        title={formatUsdMicrosExactTitle(amountUsdMicros)}
      >
        {formatUsdMicrosSummary(amountUsdMicros)}
      </span>
      {note ? (
        <span className="w-full pl-6 text-[11px] text-zinc-600 sm:w-auto sm:pl-0">
          {note}
        </span>
      ) : null}
    </li>
  );
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
  className,
}: Readonly<{
  usedUsdMicros: string | null | undefined;
  planIncludedUsdMicros?: string | null;
  creditBalanceUsdMicros?: string | null;
  paymentMethod?: { brand?: string | null; last4?: string | null } | null;
  className?: string;
}>) {
  const waterfall = buildCostWaterfall({
    usedUsdMicros,
    planIncludedUsdMicros,
    creditBalanceUsdMicros,
  });

  const cardLabel = formatPaymentMethodLabel(paymentMethod);
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
          label={cardLabel ? `Charged to ${cardLabel}` : "Charged to card"}
          amountUsdMicros={waterfall.card.appliedUsdMicros}
          muted={!cardLabel}
          note={cardLabel ? null : "No payment method attached"}
        />
      </ul>
    </div>
  );
}
