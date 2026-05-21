#!/usr/bin/env node

const { readFileSync, readdirSync, statSync } = require("fs");
const { join, relative } = require("path");

const repoRoot = process.cwd();
const srcRoot = join(repoRoot, "src");

const monitoredFiles = [
  "src/app/dashboard/page.tsx",
  "src/app/streams/page.tsx",
  "src/app/users/page.tsx",
  "src/app/users/[id]/page.tsx",
  "src/app/signer/page.tsx",
  "src/app/api/signer/sign-orchestrator-info/route.ts",
  "src/app/api/signer/sign-byoc-job/route.ts",
  "src/app/api/signer/discover-orchestrators/route.ts",
  "src/app/api/signer/generate-live-payment/route.ts",
  "src/app/api/v1/admin/apps/route.ts",
  "src/app/api/v1/admin/apps/[id]/review/route.ts",
  "src/app/api/v1/admin/apps/[id]/revoke/route.ts",
  "src/app/api/v1/apps/route.ts",
  "src/app/api/v1/apps/[id]/route.ts",
  "src/app/api/v1/apps/[id]/settings/route.ts",
  "src/app/api/v1/apps/[id]/domains/route.ts",
  "src/app/api/v1/apps/[id]/admins/route.ts",
  "src/app/api/v1/apps/[id]/credentials/route.ts",
  "src/app/api/v1/apps/[id]/users/route.ts",
  "src/app/api/v1/apps/[id]/keys/route.ts",
  "src/app/api/v1/apps/[id]/billing/route.ts",
  "src/app/api/v1/apps/[id]/usage/route.ts",
  "src/app/api/v1/apps/[id]/submit/route.ts",
  "src/app/api/v1/apps/[id]/publish/route.ts",
  "src/app/api/v1/apps/[id]/revert-draft/route.ts",
  "src/app/api/v1/apps/[id]/users/[externalUserId]/token/route.ts",
  "src/app/api/v1/apps/[id]/plans/route.ts",
  "src/app/api/v1/apps/[id]/plans/discovery/route.ts",
  "src/app/api/v1/apps/[id]/discovery-profiles/route.ts",
  "src/app/api/v1/apps/[id]/discovery-profiles/[profileId]/route.ts",
  "src/app/api/v1/subscriptions/route.ts",
  "src/app/api/v1/end-users/route.ts",
  "src/app/api/v1/billing/route.ts",
  "src/app/api/v1/tokens/route.ts",
  "src/app/api/v1/auth/validate/route.ts",
  "src/app/api/v1/admin/invites/route.ts",
  "src/app/api/v1/health/route.ts",
  "src/app/api/v1/marketplace/route.ts",
  "src/app/api/v1/marketplace/[id]/route.ts",
  "src/app/api/v1/oidc/[...oidc]/route.ts",
  "src/app/api/v1/oidc/interaction/[uid]/route.ts",
  "src/app/api/v1/oidc/device/verify/route.ts",
  "src/app/api/v1/signer/route.ts",
  "src/app/api/v1/signer/control/route.ts",
  "src/app/api/v1/signer/logs/route.ts",
  "src/app/api/v1/signer/cli-status/route.ts",
];

const dbImportRegex = /from\s+["']@\/db\/(index|schema(?:["'])?)["']|import\s*\(\s*["']@\/db\/(index|schema)["']\s*\)/g;
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);

const allowedDomainRuntimeDbImports = new Set([]);

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
for (const relativePath of monitoredFiles) {
  const absolutePath = join(repoRoot, relativePath);
  const contents = readFileSync(absolutePath, "utf8");
  if (dbImportRegex.test(contents)) {
    violations.push(relativePath);
  }
  dbImportRegex.lastIndex = 0;
}

for (const absolutePath of walk(join(srcRoot, "domains"))) {
  const relativePath = relative(repoRoot, absolutePath).replaceAll("\\", "/");
  const contents = readFileSync(absolutePath, "utf8");
  if (!dbImportRegex.test(contents)) {
    dbImportRegex.lastIndex = 0;
    continue;
  }
  dbImportRegex.lastIndex = 0;

  if (relativePath.includes("/repo/")) {
    continue;
  }
  if (allowedDomainRuntimeDbImports.has(relativePath)) {
    continue;
  }
  violations.push(relativePath);
}

if (violations.length > 0) {
  console.error("Direct @/db imports are not allowed in extracted route adapters or unapproved domain layers.");
  for (const file of violations) {
    console.error(`- ${file}`);
  }
  console.error("Move DB access into repo modules under src/domains/**/repo/** or into src/platform/** infrastructure modules.");
  process.exit(1);
}

console.log("Direct DB import check passed for extracted route adapters and monitored domain layers.");
