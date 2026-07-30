import type { CreditAllowanceSummary } from "@/lib/openmeter/credit-allowance-summary";
import {
  buildOpenMeterCustomerKey,
  buildOwnerWireSubject,
  normalizePlatformUserId,
} from "@/lib/openmeter/customer-key";
import {
  getSpendableAllowanceDetails,
  type SpendableAllowanceDetails,
} from "@/lib/openmeter/spendable-allowance";

/** Max byUser rows to enrich with OpenMeter balance lookups per app. */
export const BALANCE_ENRICH_USER_CAP = 50;

/** Concurrent spendable lookups (matches credit-allowance-summary chunking). */
export const BALANCE_ENRICH_CONCURRENCY = 8;

export type UserBalanceFields = {
  planGrantedUsdMicros: string | null;
  planRemainingUsdMicros: string | null;
  planConsumedUsdMicros: string | null;
  spendableUsdMicros: string | null;
};

/** Minimal byUser shape for enrichment (avoids circular imports with dashboard-data). */
export type EnrichableUserUsageRow = {
  endUserId: string;
  externalUserId: string | null;
  userLabel: string;
  networkFeeUsdMicros?: string;
  isOwnerWallet?: boolean;
} & Partial<UserBalanceFields>;

export function emptyUserBalanceFields(): UserBalanceFields {
  return {
    planGrantedUsdMicros: null,
    planRemainingUsdMicros: null,
    planConsumedUsdMicros: null,
    spendableUsdMicros: null,
  };
}

/**
 * True when a meter `external_user_id` is the app owner's shared wallet
 * (bare id, `owner:{id}`, or transitional compound keys).
 */
export function isOwnerWalletExternalUserId(
  ownerId: string,
  externalUserId: string | null | undefined,
  publicClientId?: string | null,
): boolean {
  const owner = ownerId.trim();
  const raw = externalUserId?.trim();
  if (!owner || !raw) {
    return false;
  }
  if (normalizePlatformUserId(raw) === owner) {
    return true;
  }
  const clientId = publicClientId?.trim();
  if (!clientId) {
    return false;
  }
  return (
    raw === buildOpenMeterCustomerKey(clientId, owner) ||
    raw === buildOpenMeterCustomerKey(clientId, buildOwnerWireSubject(owner))
  );
}

export function parseNetworkFeeMicros(raw: string | null | undefined): bigint {
  if (!raw?.trim()) {
    return 0n;
  }
  try {
    return BigInt(raw.trim());
  } catch {
    return 0n;
  }
}

/** Split network fee totals into owner-wallet vs end-user rows. */
export function computeWalletFeeRollups(
  byUser: ReadonlyArray<
    Pick<EnrichableUserUsageRow, "networkFeeUsdMicros" | "isOwnerWallet">
  >,
): {
  endUserNetworkFeeUsdMicros: string;
  ownerNetworkFeeUsdMicros: string;
} {
  let endUser = 0n;
  let owner = 0n;
  for (const row of byUser) {
    const fee = parseNetworkFeeMicros(row.networkFeeUsdMicros);
    if (row.isOwnerWallet) {
      owner += fee;
    } else {
      endUser += fee;
    }
  }
  return {
    endUserNetworkFeeUsdMicros: endUser.toString(),
    ownerNetworkFeeUsdMicros: owner.toString(),
  };
}

/**
 * Prefer highest-fee users for balance enrichment. Returns selected rows and
 * whether more users were skipped.
 */
export function selectUsersForBalanceEnrichment<T extends { networkFeeUsdMicros?: string }>(
  byUser: readonly T[],
  cap: number = BALANCE_ENRICH_USER_CAP,
): { selected: T[]; truncated: boolean } {
  if (byUser.length <= cap) {
    return { selected: [...byUser], truncated: false };
  }
  const ranked = [...byUser].sort((a, b) => {
    const feeA = parseNetworkFeeMicros(a.networkFeeUsdMicros);
    const feeB = parseNetworkFeeMicros(b.networkFeeUsdMicros);
    if (feeA === feeB) {
      return 0;
    }
    return feeB > feeA ? 1 : -1;
  });
  return {
    selected: ranked.slice(0, cap),
    truncated: true,
  };
}

export function balanceFieldsFromSpendable(
  details: SpendableAllowanceDetails | null,
): UserBalanceFields {
  if (!details) {
    return emptyUserBalanceFields();
  }
  const granted = BigInt(details.grantedUsdMicros);
  const remaining = BigInt(details.remainingPlanDiscountUsdMicros);
  const consumed = granted > remaining ? granted - remaining : 0n;
  return {
    planGrantedUsdMicros: details.grantedUsdMicros,
    planRemainingUsdMicros: details.remainingPlanDiscountUsdMicros,
    planConsumedUsdMicros: consumed.toString(),
    spendableUsdMicros: details.spendableUsdMicros,
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]!);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * Attach plan remaining + spendable to byUser rows (fail-open per user).
 * Caps enrichment to the top fee spenders.
 */
export async function enrichByUserBalanceFields<T extends EnrichableUserUsageRow>(input: {
  publicClientId: string;
  byUser: T[];
  cap?: number;
  concurrency?: number;
  /** Injected for tests. */
  lookupSpendable?: (externalUserId: string) => Promise<SpendableAllowanceDetails | null>;
}): Promise<{ byUser: T[]; balancesTruncated: boolean }> {
  const { selected, truncated } = selectUsersForBalanceEnrichment(
    input.byUser,
    input.cap ?? BALANCE_ENRICH_USER_CAP,
  );
  const enrichIds = new Set(
    selected
      .map((row) => row.externalUserId?.trim() || row.endUserId.trim())
      .filter(Boolean),
  );

  const lookup =
    input.lookupSpendable ??
    (async (externalUserId: string) =>
      getSpendableAllowanceDetails({
        clientId: input.publicClientId,
        externalUserId,
      }));

  const balanceByExternalId = new Map<string, UserBalanceFields>();
  const ids = [...enrichIds];
  const lookedUp = await mapWithConcurrency(
    ids,
    input.concurrency ?? BALANCE_ENRICH_CONCURRENCY,
    async (externalUserId) => {
      try {
        const details = await lookup(externalUserId);
        return {
          externalUserId,
          fields: balanceFieldsFromSpendable(details),
        };
      } catch (err) {
        console.warn(
          "billing-usage-balance-enrich: spendable lookup failed",
          input.publicClientId,
          externalUserId,
          err instanceof Error ? err.message : String(err),
        );
        return {
          externalUserId,
          fields: emptyUserBalanceFields(),
        };
      }
    },
  );
  for (const row of lookedUp) {
    balanceByExternalId.set(row.externalUserId, row.fields);
  }

  const byUser = input.byUser.map((row) => {
    const key = row.externalUserId?.trim() || row.endUserId.trim();
    if (!enrichIds.has(key)) {
      return {
        ...row,
        ...emptyUserBalanceFields(),
      };
    }
    const fields = balanceByExternalId.get(key) ?? emptyUserBalanceFields();
    return {
      ...row,
      ...fields,
    };
  }) as T[];

  return { byUser, balancesTruncated: truncated };
}

export function applyWalletClassification<T extends EnrichableUserUsageRow>(
  byUser: T[],
  ownerId: string,
  publicClientId: string,
): T[] {
  return byUser.map((row) => {
    const isOwnerWallet = isOwnerWalletExternalUserId(
      ownerId,
      row.externalUserId ?? row.endUserId,
      publicClientId,
    );
    return {
      ...row,
      isOwnerWallet,
      userLabel: isOwnerWallet ? "You" : row.userLabel,
    };
  });
}

export type WalletRollupFields = {
  endUserNetworkFeeUsdMicros: string;
  ownerNetworkFeeUsdMicros: string;
  endUserCreditAllowance: CreditAllowanceSummary | null;
  balancesTruncated: boolean;
};

export function withWalletRollups<T extends { byUser: EnrichableUserUsageRow[] }>(
  summary: T,
  extras?: {
    endUserCreditAllowance?: CreditAllowanceSummary | null;
    balancesTruncated?: boolean;
  },
): T & WalletRollupFields {
  const rollups = computeWalletFeeRollups(summary.byUser);
  return {
    ...summary,
    ...rollups,
    endUserCreditAllowance: extras?.endUserCreditAllowance ?? null,
    balancesTruncated: extras?.balancesTruncated ?? false,
  };
}
