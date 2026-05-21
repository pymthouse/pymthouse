#!/usr/bin/env node

const { readdirSync, readFileSync, statSync } = require("fs");
const { join, relative } = require("path");

const repoRoot = process.cwd();
const srcRoot = join(repoRoot, "src");

const forbiddenSpecifiers = new Map([
  ["@/lib/provider-apps", "Use src/domains/developer-apps repo/runtime modules instead of the compatibility wrapper."],
  ["@/lib/signer-proxy", "Use src/domains/signer-runtime runtime modules instead of the compatibility wrapper."],
  ["@/lib/auth", "Use src/domains/identity-access/runtime/request-auth instead of the compatibility wrapper."],
  ["@/lib/audit", "Use src/domains/identity-access/runtime/audit instead of the compatibility wrapper."],
  ["@/lib/billing", "Use src/domains/end-user-accounts repo/runtime modules instead of the compatibility wrapper."],
  ["@/lib/billing-runtime", "Use src/domains/usage-billing/service/billing-runtime instead of the compatibility wrapper."],
  ["@/lib/discovery-profile-resolve", "Use src/domains/plans-discovery/runtime/discovery-resolution instead of the compatibility wrapper."],
  ["@/lib/turnkey", "Use src/domains/identity-access or src/domains/end-user-accounts runtime modules instead of the compatibility wrapper."],
  ["@/lib/next-auth-options", "Use src/platform/auth/next-auth-options instead of the compatibility wrapper."],
  ["@/lib/next-auth-secret", "Use src/platform/auth/next-auth-secret instead of the compatibility wrapper."],
  ["@/lib/delete-developer-app", "Use src/domains/developer-apps/repo/delete-app instead of the compatibility wrapper."],
  ["@/lib/billing-usage-dashboard-data", "Use src/platform/ops/billing-usage-dashboard-data instead of the compatibility wrapper."],
  ["@/lib/billing-utils", "Use src/shared/utils/billing-utils instead of the compatibility wrapper."],
  ["@/lib/domain-whitelist", "Use src/shared/utils/domain-whitelist instead of the compatibility wrapper."],
  ["@/lib/format-usd-micros", "Use src/shared/utils/format-usd-micros instead of the compatibility wrapper."],
  ["@/lib/format-wei", "Use src/shared/utils/format-wei instead of the compatibility wrapper."],
  ["@/lib/token-hash", "Use src/shared/utils/token-hash instead of the compatibility wrapper."],
  ["@/lib/discovery-plans", "Use src/shared/discovery/discovery-plans instead of the compatibility wrapper."],
  ["@/lib/docs-base-url", "Use src/platform/docs/base-url instead of the compatibility wrapper."],
  ["@/lib/allowed-scopes", "Use src/platform/oidc/allowed-scopes instead of the compatibility wrapper."],
  ["@/lib/marketplace-constants", "Use src/platform/marketplace/constants instead of the compatibility wrapper."],
  ["@/lib/naap-catalog", "Use src/platform/catalog/naap-catalog instead of the compatibility wrapper."],
  ["@/lib/proto", "Use src/platform/livepeer/proto instead of the compatibility wrapper."],
  ["@/lib/signer-cli", "Use src/platform/signer/cli instead of the compatibility wrapper."],
  ["@/lib/signer-dmz-host-port", "Use src/platform/signer/dmz-host-port instead of the compatibility wrapper."],
  ["@/lib/signer-dmz-token", "Use src/platform/signer/dmz-token instead of the compatibility wrapper."],
  ["@/lib/signer-local-compose", "Use src/platform/signer/local-compose instead of the compatibility wrapper."],
  ["@/lib/stream-session-ui", "Use src/platform/ops/stream-session-ui instead of the compatibility wrapper."],
  ["@/lib/prices/eth-usd-oracle", "Use src/platform/ops/prices/eth-usd-oracle instead of the compatibility wrapper."],
  ["@/lib/prices/public-exchange-spot", "Use src/platform/ops/prices/public-exchange-spot instead of the compatibility wrapper."],
  ["@/lib/oidc/clients", "Use src/domains/oidc-platform/runtime/clients instead of the compatibility wrapper."],
  ["@/lib/oidc/account", "Use src/domains/oidc-platform/runtime/account instead of the compatibility wrapper."],
  ["@/lib/oidc/adapter", "Use src/domains/oidc-platform/runtime/adapter instead of the compatibility wrapper."],
  ["@/lib/oidc/programmatic-tokens", "Use src/domains/oidc-platform/runtime/programmatic-tokens instead of the compatibility wrapper."],
  ["@/lib/oidc/jwks", "Use src/domains/oidc-platform/runtime/jwks instead of the compatibility wrapper."],
  ["@/lib/oidc/device-token-exchange", "Use src/domains/oidc-platform/runtime/device-token-exchange instead of the compatibility wrapper."],
  ["@/lib/oidc/gateway-token-exchange", "Use src/domains/oidc-platform/runtime/gateway-token-exchange instead of the compatibility wrapper."],
  ["@/lib/oidc/provider", "Use src/domains/oidc-platform/runtime/provider-instance instead of the compatibility wrapper."],
  ["@/lib/oidc/branding", "Use src/domains/oidc-platform/runtime/branding instead of the compatibility wrapper."],
  ["@/lib/oidc/custom-domains", "Use src/domains/oidc-platform/runtime/custom-domains instead of the compatibility wrapper."],
  ["@/lib/oidc/app-access", "Use src/domains/oidc-platform/runtime/app-access instead of the compatibility wrapper."],
  ["@/lib/oidc/host-resolution", "Use src/domains/oidc-platform/runtime/host-context instead of the compatibility wrapper."],
  ["@/lib/oidc/access-token-verify", "Use src/domains/oidc-platform/runtime/access-token-verify instead of the compatibility wrapper."],
  ["@/lib/oidc/device-approval", "Use src/domains/oidc-platform/runtime/device-approval instead of the compatibility wrapper."],
  ["@/lib/oidc/token-exchange", "Use src/domains/oidc-platform/runtime/token-exchange instead of the compatibility wrapper."],
  ["@/lib/oidc/issuer-urls", "Use src/platform/oidc/issuer-urls instead of the compatibility wrapper."],
  ["@/lib/oidc/routes", "Use src/platform/oidc/routes instead of the compatibility wrapper."],
  ["@/lib/oidc/security", "Use src/platform/oidc/security instead of the compatibility wrapper."],
  ["@/lib/oidc/device", "Use src/platform/oidc/device instead of the compatibility wrapper."],
  ["@/lib/oidc/jwks-fetch", "Use src/platform/oidc/jwks-fetch instead of the compatibility wrapper."],
  ["@/lib/oidc/third-party-initiate-login", "Use src/platform/oidc/third-party-initiate-login instead of the compatibility wrapper."],
  ["@/lib/oidc/scopes", "Use src/platform/oidc/scopes instead of the compatibility wrapper."],
  ["@/lib/oidc/backend-m2m-scopes", "Use src/platform/oidc/backend-m2m-scopes instead of the compatibility wrapper."],
  ["@/lib/oidc/branding-shared", "Use src/platform/oidc/branding-shared instead of the compatibility wrapper."],
  ["@/lib/oidc/issuer-resolution", "Use src/platform/oidc/issuer-resolution instead of the compatibility wrapper."],
  ["@/lib/oidc/client-sibling", "Use src/platform/oidc/client-sibling instead of the compatibility wrapper."],
]);

const allowedImporterPatterns = [
  /\.test\.(ts|tsx|js|jsx)$/,
  /\/test-utils\//,
];

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const importRegex = /from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

function shouldSkipFile(filePath) {
  return allowedImporterPatterns.some((pattern) => pattern.test(filePath));
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath, files);
      continue;
    }
    if ([...sourceExtensions].some((ext) => fullPath.endsWith(ext))) {
      files.push(fullPath);
    }
  }
  return files;
}

const violations = [];
for (const filePath of walk(srcRoot)) {
  const normalizedPath = filePath.replaceAll("\\", "/");
  if (shouldSkipFile(normalizedPath)) continue;

  const contents = readFileSync(filePath, "utf8");
  for (const match of contents.matchAll(importRegex)) {
    const specifier = match[1] || match[2];
    if (!specifier || !forbiddenSpecifiers.has(specifier)) continue;
    violations.push({
      file: relative(repoRoot, filePath),
      specifier,
      message: forbiddenSpecifiers.get(specifier),
    });
  }
}

if (violations.length > 0) {
  console.error("Compatibility wrapper imports are only allowed in tests.");
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.specifier}`);
    console.error(`  ${violation.message}`);
  }
  process.exit(1);
}

console.log("Compatibility wrapper import check passed.");
