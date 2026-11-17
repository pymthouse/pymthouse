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

/** Coerce CLI JSON scalars to string; reject objects that would stringify as [object Object]. */
function asCliString(value: unknown, fallback = "0"): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

export interface SignerCliStatus {
  reachable: boolean;
  ethAddress: string | null;
  senderInfo: SenderInfo | null;
  ethBalance: string | null;
  tokenBalance: string | null;
  fetchedAt: string;
}

async function cliFetch(
  path: string,
  options?: {
    method?: "GET" | "POST";
    body?: string;
    contentType?: string;
    timeoutMs?: number;
  },
): Promise<string> {
  const url = `${getSignerCliUrl()}${path}`;
  const headers: Record<string, string> = {};
  const bearer = await getCliDmzBearer();
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }
  if (options?.contentType) {
    headers["Content-Type"] = options.contentType;
  }
  const method = options?.method ?? "GET";
  const res = await fetch(url, {
    method,
    headers,
    body: options?.body,
    signal: AbortSignal.timeout(options?.timeoutMs ?? 5000),
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = (await res.text()).trim();
    const detailSuffix = detail ? ` — ${detail}` : "";
    throw new Error(`CLI ${method} ${path} failed: ${res.status}${detailSuffix}`);
  }
  const text = await res.text();
  if (!text) throw new Error(`CLI ${method} ${path} returned empty body`);
  return text;
}

async function cliGet<T>(path: string): Promise<T> {
  const text = await cliFetch(path);
  return JSON.parse(text) as T;
}

async function cliGetText(path: string): Promise<string> {
  return cliFetch(path);
}

/**
 * GET /senderInfo — returns deposit, reserve, and withdraw round.
 * This is what livepeer_cli uses to show gateway payment state.
 */
export async function getSenderInfo(): Promise<SenderInfo | null> {
  try {
    const raw = await cliGet<Record<string, unknown>>("/senderInfo");
    // Normalize: go-livepeer may return PascalCase or camelCase field names
    const deposit = asCliString(raw.deposit ?? raw.Deposit);
    const withdrawRound = asCliString(raw.withdrawRound ?? raw.WithdrawRound);
    const reserve = (raw.reserve ?? raw.Reserve) as
      | Record<string, unknown>
      | undefined;
    return {
      deposit,
      withdrawRound,
      reserve: {
        fundsRemaining: asCliString(
          reserve?.fundsRemaining ?? reserve?.FundsRemaining,
        ),
        claimedInCurrentRound: asCliString(
          reserve?.claimedInCurrentRound ?? reserve?.ClaimedInCurrentRound,
        ),
      },
    };
  } catch {
    return null;
  }
}

/**
 * GET /ethAddr — Ethereum account address (plain text, not JSON).
 */
export async function getEthAddr(): Promise<string | null> {
  try {
    const raw = (await cliGetText("/ethAddr")).trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
      return raw;
    }
    return null;
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
 * POST /fundDepositAndReserve — funds TicketBroker deposit and reserve.
 * Blocks until the transaction is mined (go-livepeer CheckTx).
 */
export async function fundDepositAndReserve(
  depositWei: string,
  reserveWei: string,
): Promise<void> {
  const body = new URLSearchParams({
    depositAmount: depositWei,
    reserveAmount: reserveWei,
  }).toString();
  await cliFetch("/fundDepositAndReserve", {
    method: "POST",
    body,
    contentType: "application/x-www-form-urlencoded",
    timeoutMs: 300_000,
  });
}

/**
 * Fetch all live CLI state in parallel.
 */
export async function fetchSignerCliStatus(): Promise<SignerCliStatus> {
  const [senderInfo, ethBalance, tokenBalance, ethAddress] = await Promise.all([
    getSenderInfo(),
    getEthBalance(),
    getTokenBalance(),
    getEthAddr(),
  ]);
  return {
    reachable: senderInfo !== null,
    ethAddress,
    senderInfo,
    ethBalance,
    tokenBalance,
    fetchedAt: new Date().toISOString(),
  };
}
