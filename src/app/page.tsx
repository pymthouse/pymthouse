import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { redirect } from "next/navigation";
import Link from "next/link";
import { AppCard, type HomeApp } from "@/components/AppCard";
import { MarketingFooter } from "@/components/MarketingFooter";
import { db } from "@/db/index";
import { developerApps, oidcClients } from "@/db/schema";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { getDocsBaseUrl } from "@/lib/docs-base-url";

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
  };
}

// ─── Illustration components ─────────────────────────────────────────────────


function TokenFlowDiagram() {
  return (
    <div className="relative mx-auto max-w-lg select-none">
      <div className="absolute inset-0 flex items-center justify-center">
        <svg viewBox="0 0 400 80" className="w-full opacity-30" fill="none" stroke="currentColor">
          <line x1="100" y1="40" x2="200" y2="40" strokeWidth="1.5" strokeDasharray="4 3" className="text-emerald-500" />
          <line x1="200" y1="40" x2="300" y2="40" strokeWidth="1.5" strokeDasharray="4 3" className="text-emerald-500" />
        </svg>
      </div>
      <div className="relative flex items-center justify-between gap-2">
        <div className="flex flex-col items-center gap-2">
          <div className="w-14 h-14 rounded-xl bg-zinc-800 border border-zinc-700 flex items-center justify-center shadow-lg">
            <svg className="w-6 h-6 text-zinc-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
          </div>
          <span className="text-[10px] text-zinc-500 font-mono">Your App</span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500/30 to-teal-500/20 border border-emerald-500/40 flex items-center justify-center shadow-xl shadow-emerald-500/10">
            <span className="text-xs font-bold tracking-tight">
              <span className="text-emerald-400">p</span>
              <span className="text-zinc-200">h</span>
            </span>
          </div>
          <span className="text-[10px] text-emerald-400 font-mono font-semibold">pymthouse</span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <div className="w-14 h-14 rounded-xl bg-zinc-800 border border-zinc-700 flex items-center justify-center shadow-lg">
            <svg className="w-6 h-6 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <span className="text-[10px] text-zinc-500 font-mono">Livepeer</span>
        </div>
      </div>
      <div className="absolute -top-5 left-1/2 -translate-x-1/2">
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-[9px] font-mono text-emerald-300 shadow">
          <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
          </svg>
          OIDC token
        </span>
      </div>
    </div>
  );
}

function BillingWidget() {
  const bars = [40, 65, 50, 80, 55, 90, 70];
  return (
    <div className="mx-auto max-w-xs rounded-xl bg-zinc-900 border border-zinc-800 p-4 shadow-xl select-none">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-zinc-300">Usage this month</span>
        <span className="text-xs text-emerald-400 font-mono">↑ 24%</span>
      </div>
      <div className="flex items-end gap-1 h-16 mb-3">
        {bars.map((h, i) => (
          <div key={i} className="flex-1 rounded-sm bg-emerald-500/20 border-b-2 border-emerald-500" style={{ height: `${h}%` }} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-zinc-800/60 p-2">
          <p className="text-[10px] text-zinc-500 mb-0.5">Total requests</p>
          <p className="text-sm font-semibold text-zinc-200 font-mono">128,430</p>
        </div>
        <div className="rounded-lg bg-zinc-800/60 p-2">
          <p className="text-[10px] text-zinc-500 mb-0.5">Revenue</p>
          <p className="text-sm font-semibold text-emerald-400 font-mono">$1,284</p>
        </div>
      </div>
    </div>
  );
}

function CodeSnippet() {
  return (
    <div className="mx-auto max-w-sm rounded-xl bg-zinc-950 border border-zinc-800 shadow-xl overflow-hidden select-none">
      <div className="flex items-center gap-1.5 px-4 py-3 border-b border-zinc-800 bg-zinc-900/60">
        <span className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
        <span className="w-2.5 h-2.5 rounded-full bg-amber-500/70" />
        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/70" />
        <span className="ml-2 text-[10px] font-mono text-zinc-500">token-exchange.ts</span>
      </div>
      <div className="px-4 py-4 space-y-0.5 font-mono text-[11px] leading-5">
        <p><span className="text-zinc-500">{"// Mint a short-lived user token"}</span></p>
        <p><span className="text-purple-400">const</span>{" "}<span className="text-zinc-200">token</span>{" "}={" "}<span className="text-amber-300">await</span>{" "}<span className="text-teal-300">pymthouse</span><span className="text-zinc-400">.tokens.</span><span className="text-sky-300">mint</span><span className="text-zinc-400">({"{"}</span></p>
        <p className="pl-4"><span className="text-zinc-300">userId</span><span className="text-zinc-400">:</span>{" "}<span className="text-emerald-300">&quot;user_42&quot;</span><span className="text-zinc-400">,</span></p>
        <p className="pl-4"><span className="text-zinc-300">scopes</span><span className="text-zinc-400">:</span>{" "}<span className="text-zinc-400">[</span><span className="text-emerald-300">&quot;livepeer:stream&quot;</span><span className="text-zinc-400">],</span></p>
        <p className="pl-4"><span className="text-zinc-300">ttl</span><span className="text-zinc-400">:</span>{" "}<span className="text-sky-300">300</span><span className="text-zinc-400">,</span></p>
        <p><span className="text-zinc-400">{"}"});</span></p>
        <p className="pt-1"><span className="text-zinc-500">{"// → { access_token: \"pmth_…\" }"}</span></p>
      </div>
    </div>
  );
}

function ScalePillars() {
  const pillars = [
    { icon: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z", label: "Security-first", color: "emerald" },
    { icon: "M13 10V3L4 14h7v7l9-11h-7z", label: "Low latency", color: "amber" },
    { icon: "M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15", label: "High Availability", color: "sky" },
    { icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z", label: "Usage metered", color: "purple" },
  ];
  const colorMap: Record<string, string> = {
    emerald: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    amber: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    sky: "bg-sky-500/10 text-sky-400 border-sky-500/20",
    purple: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  };
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {pillars.map(({ icon, label, color }) => (
        <div key={label} className={`flex flex-col items-center gap-2 rounded-xl border p-4 text-center ${colorMap[color]}`}>
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={icon} />
          </svg>
          <span className="text-xs font-medium">{label}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Static data ──────────────────────────────────────────────────────────────

const USE_CASES = [
  {
    tag: "AI Video Apps",
    tagColor: "bg-purple-500/15 text-purple-300 border-purple-500/25",
    headline: "Ship AI video apps in days, not months",
    body: "Stop wrestling with OAuth servers and billing pipelines. pymthouse gives your Livepeer-powered AI video app a full OIDC identity layer, usage-based metering, and a managed payment signer — so you ship features, not infrastructure.",
    bullets: [
      "One API call to mint a scoped user token",
      "Per-request pixel-unit billing, no approximations",
      "Plug into any existing auth flow via RFC 8693 token exchange",
    ],
    visual: <CodeSnippet />,
    flip: false,
  },
  {
    tag: "Multi-Tenant Platforms",
    tagColor: "bg-sky-500/15 text-sky-300 border-sky-500/25",
    headline: "One platform, unlimited tenant apps",
    body: "Register multiple developer apps under a single pymthouse instance. Each app gets isolated OIDC clients, its own user namespace, independent billing plans, and a branded login page — all managed from one dashboard.",
    bullets: [
      "White-label login UI per app, custom domain-ready",
      "Separate web and M2M OIDC clients per app",
      "Granular scope control per client",
    ],
    visual: <BillingWidget />,
    flip: true,
  },
  {
    tag: "Livepeer Providers",
    tagColor: "bg-teal-500/15 text-teal-300 border-teal-500/25",
    headline: "Add Livepeer streaming payments to your app",
    body: "Our remote signing infrastructure integrates via a single API endpoint - it authenticates your users, signs Livepeer payments on their behalf, and gives you usage metering API out of the box.",
    bullets: [
      "One endpoint replaces your entire signer stack",
      "Per-user, per-app cost metering, fully integrated with your app",
      "Live payments monitoring",
    ],
    visual: <TokenFlowDiagram />,
    flip: false,
  },
] as const;

const STATS = [
  { value: "< 5 min", label: "Time to first token" },
  { value: "RFC 8693", label: "Standards compliant" },
  { value: "100%", label: "Open source" },
  { value: "0 lock-in", label: "Self-hostable" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function HomePage() {
  const session = await getServerSession(authOptions);
  if (session) redirect("/dashboard");

  const docsUrl = getDocsBaseUrl();

  // Fetch published apps for the showcase
  const rows = await db
    .select({
      id: developerApps.id,
      name: developerApps.name,
      subtitle: developerApps.subtitle,
      description: developerApps.description,
      category: developerApps.category,
      developerName: developerApps.developerName,
      marketplaceFeatured: developerApps.marketplaceFeatured,
      publishedAt: developerApps.publishedAt,
    })
    .from(developerApps)
    .leftJoin(oidcClients, eq(developerApps.oidcClientId, oidcClients.id))
    .where(
      and(
        eq(developerApps.status, "approved"),
        isNotNull(developerApps.publishedAt),
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
      featured: r.marketplaceFeatured === 1,
    }));

  const featuredApps = mapped.filter((a) => a.featured).slice(0, 4).map(toHomeApp);

  let showcaseApps: HomeApp[] = featuredApps;
  let showcaseTitle = "Featured apps";

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
      ORDER BY COALESCE(u.cnt, 0) DESC, d.published_at::timestamptz DESC NULLS LAST
      LIMIT 4
    `);
    const byId = new Map(mapped.map((m) => [m.id, toHomeApp(m)]));
    showcaseApps = rankRows.map((r) => byId.get(r.id)).filter((a): a is HomeApp => a !== undefined);
    if (showcaseApps.length === 0) showcaseApps = mapped.slice(0, 4).map(toHomeApp);
    showcaseTitle = "Popular apps";
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">

      {/* ── Nav ── */}
      <nav className="border-b border-zinc-800/50 sticky top-0 z-30 bg-zinc-950/90 backdrop-blur">
        <div className="max-w-5xl mx-auto flex items-center justify-between px-6 py-4">
          <Link href="/" className="text-xl font-bold tracking-tight">
            <span className="text-emerald-400">pymt</span>house
          </Link>
          <div className="flex items-center gap-3 sm:gap-4">
            <a
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:block text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Docs
            </a>
            <Link
              href="/marketplace"
              className="hidden sm:block text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Marketplace
            </Link>
            <a
              href="https://github.com/pymthouse/pymthouse"
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 border border-transparent hover:border-zinc-700 transition-colors"
              aria-label="pymthouse on GitHub"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.463 2 11.97c0 4.404 2.865 8.14 6.839 9.458.5.092.682-.216.682-.481 0-.237-.009-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .268.18.578.688.48C19.138 20.107 22 16.373 22 11.969 22 6.463 17.522 2 12 2z" />
              </svg>
            </a>
            <Link
              href="/login"
              className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors"
            >
              Sign in
            </Link>
          </div>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="relative overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-32 flex justify-center">
          <div className="w-[800px] h-[500px] rounded-full bg-emerald-600/10 blur-3xl" />
        </div>
        <div className="relative max-w-5xl mx-auto px-6 pt-20 pb-16 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Built for Livepeer builders
          </span>
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight mb-6 leading-tight">
            Everything your app needs.
            <br />
            <span className="text-emerald-400">Nothing it doesn&apos;t.</span>
          </h1>
          <p className="text-lg text-zinc-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            pymthouse is the hosted backend layer that turns raw Livepeer infrastructure
            into a production-ready platform — identity, billing, and payments as a service.
          </p>
          <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <a
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full sm:w-auto px-8 py-3 text-sm font-semibold text-zinc-200 border border-zinc-700 rounded-xl hover:border-zinc-500 hover:bg-zinc-900/50 transition-colors"
            >
              Read the docs →
            </a>
            <Link
              href="/login"
              className="w-full sm:w-auto px-8 py-3 text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl shadow-lg shadow-emerald-500/20 transition-colors"
            >
              Start Building — it&apos;s free
            </Link>
            <Link
              href="/marketplace"
              className="w-full sm:w-auto px-8 py-3 text-sm font-semibold text-zinc-200 border border-zinc-700 rounded-xl hover:border-zinc-500 hover:bg-zinc-900/50 transition-colors"
            >
              Marketplace
            </Link>
          </div>
        </div>
      </section>

      {/* ── Stats bar ── */}
      <section className="border-y border-zinc-800/60 bg-zinc-900/30">
        <div className="max-w-5xl mx-auto px-6 py-8 grid grid-cols-2 sm:grid-cols-4 gap-6">
          {STATS.map(({ value, label }) => (
            <div key={label} className="text-center">
              <p className="text-2xl sm:text-3xl font-bold text-zinc-100 mb-1">{value}</p>
              <p className="text-xs text-zinc-500">{label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Use-case sections ── */}
      <div id="solutions" className="max-w-5xl mx-auto px-6 py-20 space-y-28 scroll-mt-24">
        {USE_CASES.map(({ tag, tagColor, headline, body, bullets, visual, flip }) => (
          <section
            key={tag}
            className={`flex flex-col ${flip ? "lg:flex-row-reverse" : "lg:flex-row"} items-center gap-12`}
          >
            <div className="flex-1 space-y-5">
              <span className={`inline-block text-[11px] font-semibold uppercase tracking-widest rounded-full border px-3 py-1 ${tagColor}`}>
                {tag}
              </span>
              <h2 className="text-2xl sm:text-3xl font-bold text-zinc-100 leading-snug">{headline}</h2>
              <p className="text-zinc-400 leading-relaxed">{body}</p>
              <ul className="space-y-2">
                {bullets.map((b) => (
                  <li key={b} className="flex items-start gap-2 text-sm text-zinc-300">
                    <svg className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    {b}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex-1 w-full">
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8">
                {visual}
              </div>
            </div>
          </section>
        ))}
      </div>

      {/* ── Open standards pillars ── */}
      <section className="max-w-5xl mx-auto px-6 pb-20">
        <h2 className="text-xl font-bold text-zinc-100 text-center mb-8">Built on open standards</h2>
        <ScalePillars />
      </section>

      {/* ── How it works ── */}
      <section className="border-t border-zinc-800/60 bg-zinc-900/20 py-20">
        <div className="max-w-5xl mx-auto px-6">
          <h2 className="text-2xl sm:text-3xl font-bold text-zinc-100 text-center mb-4">How it works</h2>
          <p className="text-zinc-500 text-center mb-14 max-w-xl mx-auto">
            Three steps from zero to a billing-enabled Livepeer app.
          </p>
          <div className="grid sm:grid-cols-3 gap-8">
            {[
              { step: "01", title: "Register your app", desc: "Create a developer app in the dashboard. You get a web OIDC client and an M2M confidential client in seconds.", color: "emerald" },
              { step: "02", title: "Integrate the SDK", desc: "Use the Builder API to provision users, mint short-lived tokens, and sign directly against the remote signer DMZ.", color: "sky" },
              { step: "03", title: "Monetise & monitor", desc: "Set usage plans, watch live streams in your dashboard, and collect usage data — all without touching billing code.", color: "amber" },
            ].map(({ step, title, desc, color }) => {
              const ring: Record<string, string> = {
                emerald: "border-emerald-500/40 text-emerald-400",
                sky: "border-sky-500/40 text-sky-400",
                amber: "border-amber-500/40 text-amber-400",
              };
              return (
                <div key={step}>
                  <div className={`w-10 h-10 rounded-xl border flex items-center justify-center font-mono text-sm font-bold mb-4 ${ring[color]}`}>
                    {step}
                  </div>
                  <h3 className="font-semibold text-zinc-200 mb-2">{title}</h3>
                  <p className="text-sm text-zinc-500 leading-relaxed">{desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Built on pymthouse — app showcase ── */}
      {showcaseApps.length > 0 && (
        <section className="max-w-5xl mx-auto px-6 py-20 w-full">
          <div className="flex items-end justify-between gap-4 mb-8">
            <div>
              <h2 className="text-2xl font-bold text-zinc-100">{showcaseTitle}</h2>
              <p className="text-sm text-zinc-500 mt-1">
                {featuredApps.length > 0
                  ? "Hand-picked apps built on pymthouse"
                  : "Top apps by usage on the network"}
              </p>
            </div>
            <Link href="/marketplace" className="text-sm text-emerald-400 hover:text-emerald-300 shrink-0">
              View all →
            </Link>
          </div>
          <div className="grid gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            {showcaseApps.map((app) => (
              <AppCard key={app.id} app={app} />
            ))}
          </div>
        </section>
      )}

      {/* ── CTA banner ── */}
      <section className="max-w-5xl mx-auto px-6 py-12 w-full">
        <div className="relative overflow-hidden rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-950/60 to-zinc-900 p-10 text-center">
          <div aria-hidden className="pointer-events-none absolute -top-20 left-1/2 -translate-x-1/2 w-96 h-96 rounded-full bg-emerald-500/10 blur-3xl" />
          <div className="relative">
            <h2 className="text-2xl sm:text-3xl font-bold text-zinc-100 mb-4">Ready to launch?</h2>
            <p className="text-zinc-400 mb-8 max-w-md mx-auto">
              Join early builders on the Livepeer network. Free during beta — billing activates when you&apos;re ready.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link
                href="/login"
                className="w-full sm:w-auto px-8 py-3 text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl shadow-lg shadow-emerald-500/20 transition-colors"
              >
                Start Building — it&apos;s free
              </Link>
              <Link
                href="/marketplace"
                className="w-full sm:w-auto px-8 py-3 text-sm font-semibold text-zinc-300 border border-zinc-700 rounded-xl hover:border-zinc-500 hover:bg-zinc-800/50 transition-colors"
              >
                Explore the Marketplace
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <div className="max-w-5xl mx-auto w-full px-6 pb-10 mt-auto">
        <MarketingFooter />
      </div>
    </div>
  );
}
