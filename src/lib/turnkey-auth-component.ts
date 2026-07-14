/**
 * AuthComponent is not in @turnkey/react-wallet-kit's public exports.
 * Resolve the ESM (.mjs) build via a stable alias (see next.config.ts /
 * tsconfig paths) so it shares ClientContext with TurnkeyProvider.
 * The CJS (.js) build uses a separate Hook.js module instance and crashes:
 * "useTurnkey must be used within TurnkeyProvider".
 */
export { AuthComponent } from "@turnkey/react-wallet-kit/auth-component";
