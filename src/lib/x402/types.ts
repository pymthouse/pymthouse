export const BASE_MAINNET_CAIP2 = "eip155:8453";

/** Native USDC on Base. */
export const BASE_USDC_ADDRESS =
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;

export type X402PaymentRequirements = {
  scheme: "exact";
  network: typeof BASE_MAINNET_CAIP2;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: typeof BASE_USDC_ADDRESS;
};

export type X402PaymentPayload = {
  x402Version: number;
  scheme: "exact";
  network: string;
  payload: {
    signature: string;
    authorization: TransferWithAuthorization;
  };
};

export type TransferWithAuthorization = {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
};

export type VerifiedX402Payment = {
  payer: `0x${string}`;
  payTo: `0x${string}`;
  value: bigint;
  nonce: `0x${string}`;
  validAfter: bigint;
  validBefore: bigint;
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
};
