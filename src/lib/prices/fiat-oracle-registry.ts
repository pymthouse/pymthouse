export type BillingDisplayCurrency = "USD";

export interface FiatOracleProviderDefinition {
  key: string;
  label: string;
  displayCurrency: BillingDisplayCurrency;
  stablecoinHint: string;
  enabled: boolean;
}

const ORACLE_PROVIDERS: FiatOracleProviderDefinition[] = [
  {
    key: "global_eth_usd",
    label: "Global ETH/USD spot",
    displayCurrency: "USD",
    stablecoinHint: "USDC",
    enabled: true,
  },
  {
    key: "arbitrum_eur_stable",
    label: "EUR stablecoin track (reserved)",
    displayCurrency: "USD",
    stablecoinHint: "EURC",
    enabled: false,
  },
  {
    key: "arbitrum_gbp_stable",
    label: "GBP stablecoin track (reserved)",
    displayCurrency: "USD",
    stablecoinHint: "GBPC",
    enabled: false,
  },
];

const providerByKey = new Map(ORACLE_PROVIDERS.map((provider) => [provider.key, provider]));

export function listAvailableFiatOracleProviders(): FiatOracleProviderDefinition[] {
  return ORACLE_PROVIDERS.map((provider) => ({ ...provider }));
}

export function resolveBillingOracleProviderKey(
  key: string | null | undefined,
): FiatOracleProviderDefinition {
  const normalized = key?.trim() ?? "";
  const provider = providerByKey.get(normalized);
  if (!provider?.enabled) {
    return providerByKey.get("global_eth_usd")!;
  }
  return provider;
}

