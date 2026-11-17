import {
  ACTIVE_STREAM_PAYMENT_WINDOW_MINUTES,
  countActiveStreamsByRecentPayment,
} from "@/platform/ops/active-streams";
import {
  getIssuer,
  getJwksUrlForLocalSignerDmzContainer,
} from "@/platform/oidc/issuer-urls";
import { resolveDmzHostPort } from "@/platform/signer/dmz-host-port";
import { getDefaultSignerConfig } from "../repo/signer-config";
import { listSignerStreamSessions, listSignerTransactionIds } from "../repo/signer-admin-page";
import { getSignerUrl } from "./signer-status";

export { ACTIVE_STREAM_PAYMENT_WINDOW_MINUTES };

export function formatSignerWei(wei: string | null): string {
  if (!wei || wei === "0") return "0 WEI";
  const value = BigInt(wei);
  const eth = Number(value) / 1e18;
  if (eth < 0.001) return `${wei} WEI`;
  return `${eth.toFixed(6)} ETH`;
}

export async function getSignerAdminPageData() {
  const signer = await getDefaultSignerConfig();
  if (!signer) {
    return null;
  }

  const [activeStreamCount, allSessions, allTxns] = await Promise.all([
    countActiveStreamsByRecentPayment(),
    listSignerStreamSessions(),
    listSignerTransactionIds(),
  ]);

  let totalFeeWei = 0n;
  for (const session of allSessions) {
    totalFeeWei += BigInt(session.totalFeeWei);
  }

  const oidcIssuer = getIssuer();
  return {
    signer,
    activeStreamCount,
    allSessions,
    allTxns,
    totalFeeWei,
    oidcIssuer,
    oidcAudience: oidcIssuer,
    oidcJwksUrl: getJwksUrlForLocalSignerDmzContainer(),
    dmzHostPort: resolveDmzHostPort(signer.signerPort),
    effectiveSignerUrl: getSignerUrl(signer),
    signerUrlSource: (signer.signerUrl
      ? "saved"
      : process.env.SIGNER_INTERNAL_URL
        ? "env"
        : "default") as "default" | "saved" | "env",
  };
}
