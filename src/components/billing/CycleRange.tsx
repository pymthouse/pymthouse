"use client";

import { useEffect, useState } from "react";

import { formatCycleRange } from "@/lib/billing-format";

/**
 * Billing cycle range, identical on every page that renders it.
 *
 * Cycle bounds are UTC at the data and API layer. The first render — server
 * and client alike — formats them in UTC, so markup matches and hydration is
 * clean. After mount it re-renders in the viewer's timezone.
 *
 * Rendering `toLocaleString(undefined, …)` directly is what made `/billing`
 * (a server component, TZ=UTC) and `/usage` (a client component, viewer TZ)
 * disagree about the same cycle. Doing the swap explicitly keeps both pages on
 * the same convention at every point in the lifecycle.
 */
export default function CycleRange({
  start,
  end,
  className,
}: Readonly<{ start: string; end: string; className?: string }>) {
  const [useViewerZone, setUseViewerZone] = useState(false);

  useEffect(() => {
    setUseViewerZone(true);
  }, []);

  // Locale stays fixed in both branches so only the zone changes; a locale
  // swap would also shift date order and separators on rehydrate.
  const label = useViewerZone
    ? formatCycleRange(start, end)
    : formatCycleRange(start, end, { timeZone: "UTC" });

  return <span className={className}>{label}</span>;
}
