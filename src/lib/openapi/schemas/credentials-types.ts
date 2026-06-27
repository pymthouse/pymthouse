import type { z } from "zod";
import type {
  ApiKeySignerSessionRequestBodySchema,
  ApiKeyTokenRequestBodySchema,
  ProgrammaticTokenResponseSchema,
  ProgrammaticUserTokenRequestBodySchema,
  SignerSessionSchema,
} from "./credentials";

export type ApiKeyTokenRequestBody = z.infer<typeof ApiKeyTokenRequestBodySchema>;
export type ProgrammaticTokenResponse = z.infer<typeof ProgrammaticTokenResponseSchema>;
export type ProgrammaticUserTokenRequestBody = z.infer<
  typeof ProgrammaticUserTokenRequestBodySchema
>;
export type SignerSession = z.infer<typeof SignerSessionSchema>;
export type ApiKeySignerSessionRequestBody = z.infer<
  typeof ApiKeySignerSessionRequestBodySchema
>;
