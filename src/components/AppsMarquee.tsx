import Link from "next/link";
import type { CSSProperties } from "react";
import { Instrument_Serif } from "next/font/google";
import type { HomeApp } from "@/components/AppCard";
import { toSafeLogoUrl } from "@/lib/safe-logo-url";

const titleFont = Instrument_Serif({
  weight: "400",
  subsets: ["latin"],
  style: "italic",
  display: "swap",
});

/**
 * Gap grows as the set shrinks (log scale) so short lists aren't
 * packed — and we never pad by repeating the same apps N times.
 */
function gapForCount(n: number): string {
  const rem = Math.min(6.5, Math.max(1.5, 5.75 / Math.log2(n + 1)));
  return `${rem.toFixed(2)}rem`;
}

function durationForCount(n: number): string {
  // Keep perceived speed stable as the unique track length changes.
  return `${Math.max(28, Math.round(18 + n * 4.5))}s`;
}

function MarqueeMark({ app }: Readonly<{ app: HomeApp }>) {
  const logo = toSafeLogoUrl(app.logoUrl);

  if (logo) {
    return (
      <Link
        href={`/marketplace/${app.id}`}
        className="group/mark flex h-12 max-w-[9rem] items-center justify-center opacity-40 transition-opacity duration-200 hover:opacity-90"
        title={app.name}
      >
        {/* Dynamic marketplace logos — next/image remote hosts can't enumerate them. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logo}
          alt={app.name}
          className="max-h-8 max-w-[8.5rem] object-contain object-center grayscale invert-[0.05] contrast-125"
        />
      </Link>
    );
  }

  return (
    <Link
      href={`/marketplace/${app.id}`}
      className={`${titleFont.className} text-2xl tracking-wide text-zinc-400/45 transition-colors duration-200 hover:text-zinc-200/90 sm:text-[1.65rem]`}
    >
      {app.name}
    </Link>
  );
}

/**
 * “Trusted by” marquee: unique apps only (duplicated once for a seamless loop),
 * log-spaced by count, logo-or-title marks — no boxes.
 */
export default function AppsMarquee({
  apps,
}: Readonly<{
  apps: HomeApp[];
}>) {
  if (apps.length === 0) return null;

  const unique = apps.filter(
    (app, i, arr) => arr.findIndex((a) => a.id === app.id) === i,
  );
  const n = unique.length;
  const gap = gapForCount(n);
  const duration = durationForCount(n);
  // One seamless loop copy only — never fabricate a longer fake catalog.
  const loop = n === 1 ? unique : [...unique, ...unique];

  return (
    <div className="relative">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 z-10 w-20 bg-gradient-to-r from-zinc-950 to-transparent sm:w-28"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 z-10 w-20 bg-gradient-to-l from-zinc-950 to-transparent sm:w-28"
      />

      <div className="group overflow-hidden py-4">
        <ul
          className={`flex w-max items-center motion-safe:animate-apps-marquee motion-safe:group-hover:[animation-play-state:paused] motion-reduce:mx-auto motion-reduce:w-full motion-reduce:max-w-5xl motion-reduce:flex-wrap motion-reduce:justify-center motion-reduce:animate-none ${n === 1 ? "mx-auto !w-full justify-center !animate-none" : ""}`}
          style={{
            gap,
            ...(n > 1
              ? ({
                  animationDuration: duration,
                } as CSSProperties)
              : undefined),
          }}
          aria-label="Apps on pymthouse"
        >
          {loop.map((app, i) => (
            <li
              key={`${app.id}-${i}`}
              className="shrink-0 list-none"
              aria-hidden={i >= n ? true : undefined}
            >
              <MarqueeMark app={app} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
