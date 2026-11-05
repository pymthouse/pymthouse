import { getDefaultSigner } from "../repo/signer-routing";
import { getSignerUrl, probeSignerHttpReachability } from "./signer-status";

export async function getHealthStatus() {
  const signer = await getDefaultSigner();
  let signerReachable = false;
  try {
    const probe = await probeSignerHttpReachability(getSignerUrl(signer));
    signerReachable = probe.reachable;
  } catch {}

  return {
    status: "ok" as const,
    timestamp: new Date().toISOString(),
    version: "0.1.0",
    database: "connected" as const,
    signer: {
      status: signer?.status || "unknown",
      reachable: signerReachable,
      ethAddress: signer?.ethAddress || null,
    },
  };
}
