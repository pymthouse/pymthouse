import { z } from "zod";

export const x402PaymentRequirementsSchema = z.object({
  scheme: z.literal("exact"),
  network: z.string().min(1),
  asset: z.string().min(1),
  amount: z.string().regex(/^\d+$/),
  payTo: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  maxTimeoutSeconds: z.number().int().positive().optional().default(300),
  extra: z
    .object({
      name: z.string().min(1),
      version: z.string().min(1),
      assetTransferMethod: z.literal("eip3009").optional(),
    })
    .passthrough(),
});

export const x402AuthorizationSchema = z.object({
  from: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  to: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  value: z.string().regex(/^\d+$/),
  validAfter: z.string().regex(/^\d+$/),
  validBefore: z.string().regex(/^\d+$/),
  nonce: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

export const x402PaymentPayloadSchema = z.object({
  x402Version: z.literal(2),
  scheme: z.literal("exact"),
  network: z.string().min(1),
  payload: z.object({
    signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
    authorization: x402AuthorizationSchema,
  }),
});

export const x402VerifyRequestSchema = z.object({
  paymentPayload: x402PaymentPayloadSchema,
  paymentRequirements: x402PaymentRequirementsSchema,
});

export const x402SettleRequestSchema = x402VerifyRequestSchema.extend({
  externalUserId: z.string().min(1).optional(),
});

export type X402PaymentRequirements = z.infer<typeof x402PaymentRequirementsSchema>;
export type X402PaymentPayload = z.infer<typeof x402PaymentPayloadSchema>;
export type X402VerifyRequest = z.infer<typeof x402VerifyRequestSchema>;
export type X402SettleRequest = z.infer<typeof x402SettleRequestSchema>;

export type X402VerifyResponse = {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
};

export type X402SettleResponse = {
  success: boolean;
  error?: string;
  txHash?: string;
  networkId?: string;
  payer?: string;
};
