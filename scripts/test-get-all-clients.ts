import "./load-env-first";
import { getAllClients } from "../src/domains/oidc-platform/runtime/clients";

async function main() {
  console.log("\n=== Testing getAllClients() ===\n");
  
  const clients = await getAllClients();
  
  console.log(`Found ${clients.length} OIDC clients:\n`);
  
  for (const client of clients) {
    console.log(`✓ ${client.clientId}`);
    console.log(`  Display Name: ${client.displayName}`);
    console.log(`  Auth Method: ${client.tokenEndpointAuthMethod}`);
    console.log(`  Grant Types: ${client.grantTypes.join(", ")}`);
    console.log(`  Has Secret: ${client.hasSecret ? "Yes" : "No"}`);
    console.log(`  Scopes: ${client.allowedScopes.join(", ")}`);
    console.log(`  Redirect URIs: ${client.redirectUris.length}`);
    console.log();
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
