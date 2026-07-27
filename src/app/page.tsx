import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { redirect } from "next/navigation";
import Link from "next/link";
import { type HomeApp } from "@/components/AppCard";
import { MarketingFooter } from "@/components/MarketingFooter";
import AppsMarquee from "@/components/AppsMarquee";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { getDocsBaseUrl } from "@/lib/docs-base-url";
import { notPlatformDefaultApp } from "@/lib/platform-default-app";

// ─── App showcase helpers ────────────────────────────────────────────────────

type PublishedAppRow = HomeApp & { featured: boolean };

function toHomeApp(row: PublishedAppRow): HomeApp {
  return {
    id: row.id,
    name: row.name,
    subtitle: row.subtitle,
    description: row.description,
    category: row.category,
    developerName: row.developerName,
    logoUrl: row.logoUrl,
  };
}

// ─── Illustrations ───────────────────────────────────────────────────────────

function TokenFlowDiagram() {
  return (
    <div className="mx-auto flex max-w-md select-none items-center justify-center gap-3 sm:gap-4">
      <div className="flex flex-col items-center gap-2">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-800">
          <svg className="h-5 w-5 text-zinc-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
        </div>
        <span className="font-mono text-[10px] text-zinc-500">Your App</span>
      </div>
      <div className="flex flex-col items-center gap-1 pb-5" aria-hidden>
        <span className="font-mono text-[9px] text-emerald-400/90">signed</span>
        <div className="h-px w-8 bg-emerald-500/40 sm:w-12" />
      </div>
      <div className="flex flex-col items-center gap-2">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-500/40 bg-gradient-to-br from-emerald-500/30 to-teal-500/20">
          <span className="text-xs font-bold tracking-tight">
            <span className="text-emerald-400">p</span>
            <span className="text-zinc-200">h</span>
          </span>
        </div>
        <span className="font-mono text-[10px] font-semibold text-emerald-400">pymthouse</span>
      </div>
      <div className="flex flex-col items-center gap-1 pb-5" aria-hidden>
        <span className="font-mono text-[9px] text-emerald-400/90">ticket</span>
        <div className="h-px w-8 bg-emerald-500/40 sm:w-12" />
      </div>
      <div className="flex flex-col items-center gap-2">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-800">
          <svg className="h-5 w-5 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </div>
        <span className="font-mono text-[10px] text-zinc-500">Livepeer</span>
      </div>
    </div>
  );
}

function BillingWidget() {
  const bars = [40, 65, 50, 80, 55, 90, 70];
  return (
    <div className="mx-auto max-w-xs select-none rounded-xl border border-zinc-800 bg-zinc-900 p-4 shadow-xl">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-300">Usage this month</span>
        <span className="font-mono text-xs text-emerald-400">↑ 24%</span>
      </div>
      <div className="mb-3 flex h-16 items-end gap-1">
        {bars.map((h, i) => (
          <div
            key={`bar-${i}`}
            className="flex-1 rounded-sm border-b-2 border-emerald-500 bg-emerald-500/20"
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-zinc-800/60 p-2">
          <p className="mb-0.5 text-[10px] text-zinc-500">Requests</p>
          <p className="font-mono text-sm font-semibold text-zinc-200">128,430</p>
        </div>
        <div className="rounded-lg bg-zinc-800/60 p-2">
          <p className="mb-0.5 text-[10px] text-zinc-500">Spend</p>
          <p className="font-mono text-sm font-semibold text-emerald-400">$1,284</p>
        </div>
      </div>
    </div>
  );
}

function CodeSnippet() {
  return (
    <div className="mx-auto max-w-sm select-none overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl">
      <div className="flex items-center gap-1.5 border-b border-zinc-800 bg-zinc-900/60 px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
        <span className="ml-2 font-mono text-[10px] text-zinc-500">sign.py</span>
      </div>
      <div className="space-y-0.5 px-4 py-4 font-mono text-[11px] leading-5">
        <p><span className="text-zinc-500"># One key. Real network access.</span></p>
        <p>
          <span className="text-teal-300">client</span>
          <span className="text-zinc-400">.</span>
          <span className="text-sky-300">sign</span>
          <span className="text-zinc-400">(</span>
        </p>
        <p className="pl-4">
          <span className="text-zinc-300">token</span>
          <span className="text-zinc-400">=</span>
          <span className="text-emerald-300">os.environ[&quot;PYMTHOUSE_KEY&quot;]</span>
          <span className="text-zinc-400">,</span>
        </p>
        <p className="pl-4">
          <span className="text-zinc-300">pipeline</span>
          <span className="text-zinc-400">=</span>
          <span className="text-emerald-300">&quot;text-to-video&quot;</span>
          <span className="text-zinc-400">,</span>
        </p>
        <p><span className="text-zinc-400">)</span></p>
      </div>
    </div>
  );
}

function RocketIcon({ className = "h-4 w-4" }: Readonly<{ className?: string }>) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.75}
        d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.63 2.59m5.96 11.78A14.98 14.98 0 019.63 2.59m0 0A14.97 14.97 0 015.58 5.48M9.63 2.59A14.97 14.97 0 015.58 5.48m0 0A14.97 14.97 0 003 10.5M5.58 5.48v.01"
      />
    </svg>
  );
}

const PILLARS = [
  {
    title: "Identity",
    body: "OIDC for humans and machines. Scoped tokens, white-label login, and standards that plug into what you already ship.",
    points: ["OIDC + token exchange", "Web & M2M clients", "Branded sign-in"],
  },
  {
    title: "Billing",
    body: "Usage-metered plans with a Starter allowance. See spend and requests without building a billing stack.",
    points: ["Per-request metering", "Plans & allowances", "Owner dashboards"],
  },
  {
    title: "Payments",
    body: "Remote signing for Livepeer tickets — authenticate, sign, and meter through one managed path.",
    points: ["Managed signer DMZ", "Per-user cost tracking", "Live usage monitoring"],
  },
] as const;

const STORY_CHAPTERS = [
  {
    tag: "For builders shipping product",
    tagColor: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
    headline: "From first key to paying customers",
    body: "Create your own app, mint keys, set plans, and grow users on Livepeer — without standing up OAuth, Stripe plumbing, or a payment signer.",
    bullets: [
      "Own your app, plans, and user namespace",
      "Mint signing keys in minutes",
      "Upgrade billing when you are ready",
    ],
    visual: <CodeSnippet />,
    flip: false,
  },
  {
    tag: "For platforms & multi-tenant apps",
    tagColor: "border-teal-500/25 bg-teal-500/10 text-teal-300",
    headline: "One backend. Many products.",
    body: "Register developer apps under a single pymthouse instance. Each gets isolated clients, plans, and optional white-label login — managed from one place.",
    bullets: [
      "Isolated OIDC clients per app",
      "Independent billing per tenant",
      "White-label login when you need it",
    ],
    visual: <BillingWidget />,
    flip: true,
  },
  {
    tag: "For Livepeer-native teams",
    tagColor: "border-sky-500/25 bg-sky-500/10 text-sky-300",
    headline: "Payments that match the network",
    body: "Wire your app to a remote signer endpoint. pymthouse authenticates the caller, signs Livepeer payments, and meters usage — so your product stays focused on video, not wallets.",
    bullets: [
      "One endpoint replaces a custom signer stack",
      "Per-user, per-app cost visibility",
      "Built for Livepeer payment tickets",
    ],
    visual: <TokenFlowDiagram />,
    flip: false,
  },
] as const;

const STEPS = [
  {
    step: "01",
    title: "Choose your path",
    desc: "Explorer: get a personal network key on the shared app. Builder: create your own product with plans and users.",
  },
  {
    step: "02",
    title: "Connect and sign",
    desc: "Use your API key or SDK token against the remote signer. First successful sign is the ah-ha moment.",
  },
  {
    step: "03",
    title: "Grow with metering",
    desc: "Watch usage, set plans, and add billing when customers arrive — without rewriting your payment path.",
  },
] as const;

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function HomePage() {
  const session = await getServerSession(authOptions);
  if (session) redirect("/apps");

  const docsUrl = getDocsBaseUrl();

  const rows = await db
    .select({
      id: developerApps.id,
      name: developerApps.name,
      subtitle: developerApps.subtitle,
      description: developerApps.description,
      category: developerApps.category,
      developerName: developerApps.developerName,
      logoDarkUrl: developerApps.logoDarkUrl,
      logoLightUrl: developerApps.logoLightUrl,
      marketplaceFeatured: developerApps.marketplaceFeatured,
      publishedAt: developerApps.publishedAt,
    })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(
      and(
        eq(developerApps.status, "approved"),
        isNotNull(developerApps.publishedAt),
        notPlatformDefaultApp(),
      ),
    )
    .orderBy(desc(developerApps.publishedAt));

  const mapped: PublishedAppRow[] = rows
    .filter((r): r is typeof r & { id: string } => Boolean(r.id))
    .map((r) => ({
      id: r.id,
      name: r.name,
      subtitle: r.subtitle,
      description: r.description,
      category: r.category,
      developerName: r.developerName,
      logoUrl: r.logoDarkUrl?.trim() || r.logoLightUrl?.trim() || null,
      featured: r.marketplaceFeatured === 1,
    }));

  const featuredApps = mapped.filter((a) => a.featured).slice(0, 12).map(toHomeApp);

  let showcaseApps: HomeApp[] = featuredApps;
  let showcaseTitle = "Trusted on the network";

  if (featuredApps.length === 0 && mapped.length > 0) {
    const rankRows = await db.execute<{ id: string }>(sql`
      SELECT d.id
      FROM developer_apps d
      LEFT JOIN (
        SELECT COALESCE(client_id, app_id) AS aid, COUNT(*)::bigint AS cnt
        FROM transactions
        WHERE type = 'usage'
          AND status = 'confirmed'
          AND COALESCE(client_id, app_id) IS NOT NULL
        GROUP BY COALESCE(client_id, app_id)
      ) u ON u.aid = d.id
      WHERE d.status = 'approved'
        AND d.published_at IS NOT NULL
        AND d.is_platform_default <> 1
      ORDER BY COALESCE(u.cnt, 0) DESC, d.published_at::timestamptz DESC NULLS LAST
      LIMIT 12
    `);
    const byId = new Map(mapped.map((m) => [m.id, toHomeApp(m)]));
    showcaseApps = rankRows.map((r) => byId.get(r.id)).filter((a): a is HomeApp => a !== undefined);
    if (showcaseApps.length === 0) showcaseApps = mapped.slice(0, 12).map(toHomeApp);
    showcaseTitle = "Shipping on pymthouse";
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* ── Nav ── */}
      <nav className="sticky top-0 z-30 border-b border-zinc-800/50 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-xl font-bold tracking-tight">
            <span className="text-emerald-400">pymt</span>house
          </Link>
          <div className="flex items-center gap-3 sm:gap-4">
            <a
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hidden text-sm text-zinc-400 transition-colors hover:text-zinc-200 sm:block"
            >
              Docs
            </a>
            <Link
              href="/marketplace"
              className="hidden text-sm text-zinc-400 transition-colors hover:text-zinc-200 sm:block"
            >
              Marketplace
            </Link>
            <a
              href="https://github.com/pymthouse/pymthouse"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-transparent p-2 text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-800/60 hover:text-zinc-100"
              aria-label="pymthouse on GitHub"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.463 2 11.97c0 4.404 2.865 8.14 6.839 9.458.5.092.682-.216.682-.481 0-.237-.009-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .268.18.578.688.48C19.138 20.107 22 16.373 22 11.969 22 6.463 17.522 2 12 2z" />
              </svg>
            </a>
            <Link
              href="/start"
              className="rounded-lg border border-teal-500/50 px-4 py-2 text-sm font-medium text-teal-300 transition-colors hover:border-teal-400 hover:bg-teal-500/10 hover:text-teal-200"
            >
              Get Started
            </Link>
            <Link
              href="/login"
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
            >
              Sign in
            </Link>
          </div>
        </div>
      </nav>

      {/* ── Hero: brand + one story beat ── */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_55%_at_50%_-5%,rgba(16,185,129,0.18),transparent_55%)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_50%_40%_at_90%_80%,rgba(20,184,166,0.08),transparent_50%)]"
        />
        <div className="relative mx-auto max-w-5xl px-6 pb-20 pt-16 text-center sm:pt-24">
          {/* <p className="mb-6 text-3xl font-bold tracking-tight sm:text-4xl">
            <span className="text-emerald-400">pymt</span>
            <span className="text-zinc-100">house</span>
          </p> */}
          <h1 className="mx-auto max-w-3xl text-3xl font-bold leading-tight tracking-tight sm:text-5xl lg:text-[3.25rem]">
            The business layer for{" "}
            <span className="text-emerald-400">Livepeer</span> apps
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-zinc-400 sm:text-lg">
            Identity, metering, and payment signing — so you ship product,
            not infrastructure.
          </p>
          <div className="mx-auto mt-10 flex w-full max-w-md flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <Link
              href="/start"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-8 py-3.5 text-sm font-semibold text-white shadow-lg shadow-emerald-500/20 transition-colors hover:bg-emerald-500 sm:w-auto"
            >
              <RocketIcon />
              Start Building Now
            </Link>
            <a
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full rounded-xl border border-zinc-700 px-8 py-3.5 text-sm font-semibold text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900/50 sm:w-auto"
            >
              Read the docs
            </a>
          </div>
        </div>
      </section>

      {/* ── Problem → promise ── */}
      <section className="border-y border-zinc-800/60 bg-zinc-900/25">
        <div className="mx-auto grid max-w-5xl gap-10 px-6 py-16 sm:grid-cols-2 sm:gap-14 sm:py-20">
          <div>
            <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-zinc-500">
              The gap
            </p>
            <h2 className="text-2xl font-bold tracking-tight text-zinc-100 sm:text-3xl">
              Livepeer runs the network. Metering, billing, and payments are
              still on you.
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-zinc-400 sm:text-base">
              Usage tracking, subscriptions, and payment signing eat months
              before your first customer. Most teams rebuild the same stack —
              or never ship.
            </p>
          </div>
          <div>
            <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-emerald-400/80">
              The promise
            </p>
            <h2 className="text-2xl font-bold tracking-tight text-zinc-100 sm:text-3xl">
              pymthouse handles all of it — hosted, open, and Livepeer-native.
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-zinc-400 sm:text-base">
              Get a network key in minutes as an Explorer, or ship a full
              product as a Builder. Same platform. Clear path to value in your
              first session.
            </p>
          </div>
        </div>
      </section>

      {/* ── Three pillars ── */}
      <section id="solutions" className="scroll-mt-24 px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <div className="mx-auto max-w-2xl text-center">
            <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-emerald-400/80">
              What you get
            </p>
            <h2 className="text-2xl font-bold tracking-tight text-zinc-100 sm:text-3xl">
              Three capabilities. One platform.
            </h2>
            <p className="mt-4 text-zinc-400">
              Everything between your users and Livepeer compute — without
              bolting on three vendors.
            </p>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {PILLARS.map((pillar) => (
              <div
                key={pillar.title}
                className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6"
              >
                <h3 className="text-lg font-semibold text-emerald-400">
                  {pillar.title}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-zinc-400">
                  {pillar.body}
                </p>
                <ul className="mt-5 space-y-2">
                  {pillar.points.map((point) => (
                    <li
                      key={point}
                      className="flex items-start gap-2 text-sm text-zinc-300"
                    >
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                      {point}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Paths: Explorer / Builder ── */}
      <section className="border-t border-zinc-800/60 bg-zinc-900/20 px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <div className="mx-auto max-w-2xl text-center">
            <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-teal-400/90">
              How you start
            </p>
            <h2 className="text-2xl font-bold tracking-tight text-zinc-100 sm:text-3xl">
              Pick the path that matches today
            </h2>
            <p className="mt-4 text-zinc-400">
              Explore the network — your network, upgrade to Builder when you&apos;re ready to launch your own platform!
            </p>
          </div>
          <div className="mt-12 grid gap-6 sm:grid-cols-2">
            <Link
              href="/start?persona=explorer"
              className="group rounded-2xl border border-zinc-700/80 bg-zinc-950/50 p-7 transition duration-200 hover:border-emerald-500/45 hover:bg-zinc-900/80 motion-safe:hover:-translate-y-0.5"
            >
              <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-emerald-400/90">
                Explorer
              </p>
              <h3 className="text-xl font-semibold text-zinc-50">
                Try the network
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-zinc-500 group-hover:text-zinc-400">
                Personal projects and experiments. Get a key on the shared app
                and start signing immediately.
              </p>
            </Link>
            <Link
              href="/start?persona=builder"
              className="group rounded-2xl border border-zinc-700/80 bg-zinc-950/50 p-7 transition duration-200 hover:border-teal-500/45 hover:bg-zinc-900/80 motion-safe:hover:-translate-y-0.5"
            >
              <p className="mb-3 font-mono text-xs uppercase tracking-[0.2em] text-teal-400/90">
                Builder
              </p>
              <h3 className="text-xl font-semibold text-zinc-50">
                Ship a product
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-zinc-500 group-hover:text-zinc-400">
                Your own app, keys, plans, and users — ready for customers on
                the Livepeer network.
              </p>
            </Link>
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <div className="mx-auto max-w-xl text-center">
            <h2 className="text-2xl font-bold tracking-tight text-zinc-100 sm:text-3xl">
              From signup to your first paid request
            </h2>
            <p className="mt-4 text-zinc-400">
              Three steps to the moment the product proves itself.
            </p>
          </div>
          <div className="mt-14 grid gap-10 sm:grid-cols-3">
            {STEPS.map(({ step, title, desc }) => (
              <div key={step}>
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-500/40 font-mono text-sm font-bold text-emerald-400">
                  {step}
                </div>
                <h3 className="mb-2 font-semibold text-zinc-200">{title}</h3>
                <p className="text-sm leading-relaxed text-zinc-500">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Story chapters ── */}
      <div className="mx-auto max-w-5xl space-y-28 px-6 pb-20">
        {STORY_CHAPTERS.map(({ tag, tagColor, headline, body, bullets, visual, flip }) => (
          <section
            key={tag}
            className={`flex flex-col items-center gap-12 ${flip ? "lg:flex-row-reverse" : "lg:flex-row"}`}
          >
            <div className="flex-1 space-y-5">
              <span
                className={`inline-block rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-widest ${tagColor}`}
              >
                {tag}
              </span>
              <h2 className="text-2xl font-bold leading-snug text-zinc-100 sm:text-3xl">
                {headline}
              </h2>
              <p className="leading-relaxed text-zinc-400">{body}</p>
              <ul className="space-y-2">
                {bullets.map((b) => (
                  <li key={b} className="flex items-start gap-2 text-sm text-zinc-300">
                    <svg
                      className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                      aria-hidden
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                        clipRule="evenodd"
                      />
                    </svg>
                    {b}
                  </li>
                ))}
              </ul>
            </div>
            <div className="w-full flex-1">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8">
                {visual}
              </div>
            </div>
          </section>
        ))}
      </div>

      {/* ── Proof: marketplace marquee ── */}
      {showcaseApps.length > 0 && (
        <section className="w-full border-y border-zinc-800/60 bg-zinc-950 py-14">
          <div className="mx-auto mb-8 flex max-w-5xl items-end justify-between gap-4 px-6">
            <div>
              <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-zinc-500">
                On the network
              </p>
              <h2 className="text-xl font-bold text-zinc-100 sm:text-2xl">
                {showcaseTitle}
              </h2>
              <p className="mt-1 text-sm text-zinc-500">
                {featuredApps.length > 0
                  ? "Products already shipping on pymthouse"
                  : "Top apps by usage on the network"}
              </p>
            </div>
            <Link
              href="/marketplace"
              className="shrink-0 text-sm text-emerald-400 transition-colors hover:text-emerald-300"
            >
              View all →
            </Link>
          </div>
          <AppsMarquee apps={showcaseApps} />
        </section>
      )}

      {/* ── Climactic CTA ── */}
      <section className="w-full px-6 py-12">
        <div className="relative mx-auto max-w-5xl overflow-hidden rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-950/70 via-zinc-900 to-zinc-950 px-8 py-14 text-center sm:px-12">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-24 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-emerald-500/15 blur-3xl"
          />
          <div className="relative">
            <p className="mb-4 font-mono text-xs uppercase tracking-[0.22em] text-emerald-400/90">
              First session
            </p>
            <h2 className="text-2xl font-bold text-zinc-100 sm:text-3xl">
              Make your first paid request today
            </h2>
            <p className="mx-auto mt-4 max-w-md text-zinc-400">
              Free during beta. Choose Explorer or Builder, create a wallet,
              and mint a key — then watch your first request go through.
            </p>
            <Link
              href="/start"
              className="mt-8 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-8 py-3.5 text-sm font-semibold text-white shadow-lg shadow-emerald-500/20 transition-colors hover:bg-emerald-500"
            >
              <RocketIcon />
              Start Building Now
            </Link>
          </div>
        </div>
      </section>

      <div className="mx-auto mt-auto w-full max-w-5xl px-6 pb-10">
        <MarketingFooter />
      </div>
    </div>
  );
}
