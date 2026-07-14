import type { ComponentType } from "react";

type AuthComponentProps = {
  sessionKey?: string;
  logo?: string;
  logoClassName?: string;
  title?: string;
};

/**
 * AuthComponent is not in @turnkey/react-wallet-kit's public exports.
 * Import the ESM (.mjs) build so it shares ClientContext with TurnkeyProvider
 * (also ESM). The CJS (.js) build uses a separate Hook.js module instance —
 * wrapping with TurnkeyProvider then crashes: "useTurnkey must be used within
 * TurnkeyProvider".
 */
// @ts-expect-error -- deep .mjs path has no TS resolution via package exports
import { AuthComponent as AuthComponentUntyped } from "../../node_modules/@turnkey/react-wallet-kit/dist/components/auth/index.mjs";

export const AuthComponent =
  AuthComponentUntyped as ComponentType<AuthComponentProps>;
