import { Suspense } from "react";
import X402ApprovePage from "./approve-client";

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-zinc-950 p-12 text-zinc-400">Loading…</div>
      }
    >
      <X402ApprovePage />
    </Suspense>
  );
}
