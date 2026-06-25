#!/usr/bin/env npx tsx
/**
 * Register (or print instructions for) Turnkey BALANCE_FINALIZED_UPDATES webhook
 * on the shared company signer ETH address.
 *
 * Turnkey webhook registration is not yet exposed on @turnkey/sdk-server; this script
 * validates configuration and prints the exact dashboard / API parameters to use.
 */
import "./load-env-first";
import { getSharedSignerEthAddress } from "../src/lib/turnkey/resolve-deposit-payer";

async function main() {
  const baseUrl = (
    process.env.NEXTAUTH_URL ||
    process.env.PYMTHOUSE_PUBLIC_URL ||
    "https://pymthouse.com"
  ).replace(/\/$/, "");

  const webhookUrl = `${baseUrl}/api/v1/webhooks/turnkey/balances`;
  const signerAddress = await getSharedSignerEthAddress();

  console.log("Turnkey balance webhook registration");
  console.log("====================================");
  console.log("");
  console.log("Event type:     BALANCE_FINALIZED_UPDATES");
  console.log("Webhook URL:   ", webhookUrl);
  console.log("Monitored addr:", signerAddress ?? "(unavailable — start signer or set signer_config.eth_address)");
  console.log("Chain:          Arbitrum (eip155:42161)");
  console.log("");
  console.log("Attribution model:");
  console.log("  Users send ETH from their Turnkey login wallet to the shared signer.");
  console.log("  PymtHouse resolves tx.from via Arbitrum RPC and maps walletAddress → OpenMeter customer.");
  console.log("  Unmatched deposits are logged in signer_deposit_events with status=unmatched.");
  console.log("");
  console.log("Verification:");
  console.log("  JWKS: https://api.turnkey.com/public/v1/discovery/webhooks/jwks");
  console.log("  Optional env override: TURNKEY_WEBHOOK_KEY_ID + TURNKEY_WEBHOOK_PUBLIC_KEY");
  console.log("");
  console.log(
    "Register in the Turnkey dashboard (Developers → Webhooks) or via the Turnkey API",
  );
  console.log("create_webhook activity when available in your org.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
