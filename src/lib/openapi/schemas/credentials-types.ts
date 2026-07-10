import type { z } from "zod";
import type {
  ProgrammaticTokenResponseSchema,
  ProgrammaticUserTokenRequestBodySchema,
  SignerSessionSchema,
} from "./credentials";

export type ProgrammaticTokenResponse = z.infer<typeof ProgrammaticTokenResponseSchema>;
export type ProgrammaticUserTokenRequestBody = z.infer<
  typeof ProgrammaticUserTokenRequestBodySchema
>;
export type SignerSession = z.infer<typeof SignerSessionSchema>;
