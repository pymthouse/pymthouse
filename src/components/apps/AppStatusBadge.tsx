export function appStatusAriaLabel(status: string): string {
  if (status === "approved") {
    return "Live";
  }
  return status.replaceAll("_", " ");
}

export default function AppStatusBadge({ status }: Readonly<{ status: string }>) {
  const isLive = status === "approved";
  const label = isLive ? "Live" : status.replaceAll("_", " ");
  const className = isLive
    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
    : "bg-zinc-700/40 text-zinc-400 border-zinc-700";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none ${className}`}
    >
      {isLive && (
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
      )}
      {label}
    </span>
  );
}
