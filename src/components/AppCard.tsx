import Link from "next/link";
import {
  CATEGORY_COLORS,
  DEFAULT_CATEGORY_COLOR,
} from "@/platform/marketplace/constants";

export type HomeApp = {
  id: string;
  name: string;
  subtitle: string | null;
  description: string | null;
  category: string | null;
  developerName: string | null;
};

export function AppCard({ app }: { app: HomeApp }) {
  return (
    <Link
      href={`/marketplace/${app.id}`}
      className="block p-5 border border-zinc-800 rounded-xl bg-zinc-900/30 hover:border-zinc-700 hover:bg-zinc-900/60 transition-colors group"
    >
      <div className="flex items-start gap-3 mb-3">
        <div className="w-11 h-11 bg-gradient-to-br from-emerald-500/20 to-teal-500/20 rounded-xl flex items-center justify-center text-emerald-400 text-sm font-bold shrink-0">
          {app.name[0]?.toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-zinc-200 group-hover:text-emerald-400 transition-colors truncate">
            {app.name}
          </h3>
          {app.subtitle && (
            <p className="text-xs text-zinc-500 truncate">{app.subtitle}</p>
          )}
        </div>
      </div>
      {app.description && (
        <p className="text-xs text-zinc-400 mb-3 line-clamp-2 leading-relaxed">
          {app.description}
        </p>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {app.category && (
          <span
            className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${
              CATEGORY_COLORS[app.category] || DEFAULT_CATEGORY_COLOR
            }`}
          >
            {app.category}
          </span>
        )}
        {app.developerName && (
          <span className="text-[11px] text-zinc-500">
            by {app.developerName}
          </span>
        )}
      </div>
    </Link>
  );
}
