/**
 * signer-cli.ts
 *
 * Client for go-livepeer’s CLI API (livepeer listens on 4935 inside the signer
 * container; with DMZ, PymtHouse calls Apache’s /__signer_cli proxy).
 * This is the same port that livepeer_cli connects to.
 * Must only be called server-side; the port is bound to 127.0.0.1 on the host.
 *
 * When the signer sits behind the Apache DMZ, set SIGNER_CLI_URL to the CLI base
 * URL — typically the DMZ origin plus `/__signer_cli` (e.g. http://localhost:8080/__signer_cli).
 * Alternatively, a dedicated admin listener on a second port is supported. The server
 * mints a short-lived JWT with admin scope for these requests.
 */

import { issueSignerDmzToken } from "@/lib/signer-dmz-token";

export function getSignerCliUrl(): string {
  if (process.env.SIGNER_CLI_URL) return process.env.SIGNER_CLI_URL;
  return "http://127.0.0.1:8080/__signer_cli";
}

let cliDmzTokenCache: { token: string; expMs: number } | null = null;

async function getCliDmzBearer(): Promise<string> {
  if (process.env.SIGNER_DMZ_FORWARD_JWT === "false") {
    return "";
  }
  const now = Date.now();
  if (cliDmzTokenCache && cliDmzTokenCache.expMs > now + 15_000) {
    return cliDmzTokenCache.token;
  }
  const token = await issueSignerDmzToken({
    gate: "cli",
    subject: "pymthouse-server",
  });
  cliDmzTokenCache = { token, expMs: now + 3.5 * 60 * 1000 };
  return token;
}

export interface SenderInfo {
  deposit: string;
  withdrawRound: string;
  reserve: {
    fundsRemaining: string;
    claimedInCurrentRound: string;
  };
}

export interface SignerCliStatus {
  reachable: boolean;
  senderInfo: SenderInfo | null;
  ethBalance: string | null;
  tokenBalance: string | null;
  fetchedAt: string;
}

async function cliGet<T>(path: string): Promise<T> {
  const url = `${getSignerCliUrl()}${path}`;
  const headers: Record<string, string> = {};
  const bearer = await getCliDmzBearer();
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(5000),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`CLI GET ${path} failed: ${res.status}`);
  }
  const text = await res.text();
  if (!text) throw new Error(`CLI GET ${path} returned empty body`);
  return JSON.parse(text) as T;
}

/**
 * GET /senderInfo — returns deposit, reserve, and withdraw round.
 * This is what livepeer_cli uses to show gateway payment state.
 */
export async function getSenderInfo(): Promise<SenderInfo | null> {
  try {
    const raw = await cliGet<Record<string, unknown>>("/senderInfo");
    // Normalize: go-livepeer may return PascalCase or camelCase field names
    const deposit = String(raw.deposit ?? raw.Deposit ?? "0");
    const withdrawRound = String(raw.withdrawRound ?? raw.WithdrawRound ?? "0");
    const reserve = (raw.reserve ?? raw.Reserve) as
      | Record<string, unknown>
      | undefined;
    return {
      deposit,
      withdrawRound,
      reserve: {
        fundsRemaining: String(
          reserve?.fundsRemaining ?? reserve?.FundsRemaining ?? "0"
        ),
        claimedInCurrentRound: String(
          reserve?.claimedInCurrentRound ?? reserve?.ClaimedInCurrentRound ?? "0"
        ),
      },
    };
  } catch {
    return null;
  }
}

/**
 * GET /ethBalance — ETH balance of the signer account.
 */
export async function getEthBalance(): Promise<string | null> {
  try {
    const raw = await cliGet<unknown>("/ethBalance");
    return String(raw);
  } catch {
    return null;
  }
}

/**
 * GET /tokenBalance — LPT token balance of the signer account.
 */
export async function getTokenBalance(): Promise<string | null> {
  try {
    const raw = await cliGet<unknown>("/tokenBalance");
    return String(raw);
  } catch {
    return null;
  }
}

/**
 * Fetch all live CLI state in parallel.
 */
export async function fetchSignerCliStatus(): Promise<SignerCliStatus> {
  const [senderInfo, ethBalance, tokenBalance] = await Promise.all([
    getSenderInfo(),
    getEthBalance(),
    getTokenBalance(),
  ]);
  return {
    reachable: senderInfo !== null,
    senderInfo,
    ethBalance,
    tokenBalance,
    fetchedAt: new Date().toISOString(),
  };
}
