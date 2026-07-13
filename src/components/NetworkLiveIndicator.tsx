type NetworkLiveIndicatorProps = Readonly<{
  online: boolean;
  detail: string;
  statusLabel: string;
}>;

/** Signer network status chip (admin / operator My Apps header). */
export default function NetworkLiveIndicator({
  online,
  detail,
  statusLabel,
}: NetworkLiveIndicatorProps) {
  return (
    <div
      className={`flex items-center gap-2 text-xs font-medium ${
        online ? "text-emerald-400" : "text-zinc-500"
      }`}
      title={`Signer ${online ? "Online" : statusLabel} · ${detail}`}
    >
      <span className="relative flex h-2 w-2">
        {online ? (
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
        ) : null}
        <span
          className={`relative inline-flex rounded-full h-2 w-2 ${
            online ? "bg-emerald-500" : "bg-zinc-600"
          }`}
        />
      </span>
      {online ? "Network live" : "Network offline"}
    </div>
  );
}
