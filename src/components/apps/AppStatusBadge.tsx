export function appStatusAriaLabel(status: string): string {
  switch (status) {
    case "approved":
      return "Live — approved";
    case "draft":
      return "Draft";
    case "submitted":
      return "Submitted";
    case "in_review":
      return "In review";
    case "rejected":
      return "Rejected";
    default:
      return status.replaceAll("_", " ");
  }
}

export default function AppStatusBadge({ status }: Readonly<{ status: string }>) {
  const config: Record<string, { label: string; className: string }> = {
    approved: {
      label: "Live",
      className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    },
    draft: {
      label: "Draft",
      className: "bg-zinc-700/40 text-zinc-400 border-zinc-700",
    },
    submitted: {
      label: "Submitted",
      className: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    },
    in_review: {
      label: "In review",
      className: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    },
    rejected: {
      label: "Rejected",
      className: "bg-red-500/10 text-red-400 border-red-500/20",
    },
  };

  const { label, className } = config[status] ?? {
    label: status.replaceAll("_", " "),
    className: "bg-zinc-700/40 text-zinc-400 border-zinc-700",
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none ${className}`}
    >
      {status === "approved" && (
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
      )}
      {label}
    </span>
  );
}
