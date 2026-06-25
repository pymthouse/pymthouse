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
  ethAddress: string | null;
  senderInfo: SenderInfo | null;
  ethBalance: string | null;
  tokenBalance: string | null;
  fetchedAt: string;
}

async function cliFetch(
  path: string,
  parse: "json" | "text",
  init?: RequestInit,
): Promise<string> {
  const url = `${getSignerCliUrl()}${path}`;
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  const bearer = await getCliDmzBearer();
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }
  const res = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CLI ${init?.method ?? "GET"} ${path} failed: ${res.status}${body ? ` ${body}` : ""}`);
  }
  const text = await res.text();
  if (!text) throw new Error(`CLI ${init?.method ?? "GET"} ${path} returned empty body`);
  if (parse === "text") {
    return text;
  }
  return text;
}

async function cliGet<T>(path: string): Promise<T> {
  const text = await cliFetch(path, "json");
  return JSON.parse(text) as T;
}

async function cliGetText(path: string): Promise<string> {
  return cliFetch(path, "text");
}

export type FundDepositResult = {
  txHash: string;
  mode: "deposit" | "deposit_and_reserve";
};

/** Test-only stub for fund operations. */
let testFundDepositStub:
  | ((input: {
      mode: "deposit" | "deposit_and_reserve";
      depositWei: bigint;
      reserveWei: bigint;
    }) => Promise<FundDepositResult>)
  | null = null;

export function __testSetFundDepositStub(
  stub: typeof testFundDepositStub,
): void {
  testFundDepositStub = stub;
}

export function __testClearFundDepositStub(): void {
  testFundDepositStub = null;
}

function parseFundTxHash(body: string): string {
  try {
    const parsed = JSON.parse(body) as { txHash?: string };
    if (parsed.txHash && /^0x[a-fA-F0-9]{64}$/.test(parsed.txHash)) {
      return parsed.txHash;
    }
  } catch {
    // legacy plain-text success responses
  }
  throw new Error("fundDeposit response missing txHash");
}

async function cliPostForm(path: string, fields: Record<string, string>): Promise<string> {
  const body = new URLSearchParams(fields);
  return cliFetch(path, "json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

/**
 * POST /fundDeposit — funds the shared signer TicketBroker deposit.
 * Blocks until the tx is mined (go-livepeer CheckTx).
 */
export async function fundDeposit(amountWei: bigint): Promise<FundDepositResult> {
  if (testFundDepositStub) {
    return testFundDepositStub({
      mode: "deposit",
      depositWei: amountWei,
      reserveWei: 0n,
    });
  }
  const raw = await cliPostForm("/fundDeposit", { amount: amountWei.toString() });
  return { txHash: parseFundTxHash(raw), mode: "deposit" };
}

/**
 * POST /fundDepositAndReserve — funds deposit + reserve in one tx.
 */
export async function fundDepositAndReserve(
  depositWei: bigint,
  reserveWei: bigint,
): Promise<FundDepositResult> {
  if (testFundDepositStub) {
    return testFundDepositStub({
      mode: "deposit_and_reserve",
      depositWei,
      reserveWei,
    });
  }
  const raw = await cliPostForm("/fundDepositAndReserve", {
    depositAmount: depositWei.toString(),
    reserveAmount: reserveWei.toString(),
  });
  return { txHash: parseFundTxHash(raw), mode: "deposit_and_reserve" };
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
