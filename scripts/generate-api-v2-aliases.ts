#!/usr/bin/env npx tsx
/**
 * Generate `/api/v2` alias route files: method-exact re-exports of the v1
 * Builder / End-user contract handlers, minus the excluded and guarded
 * operations in src/lib/api-version/v2-surface.ts.
 *
 *   npm run api:v2:generate          # write / prune generated files
 *   npx tsx scripts/generate-api-v2-aliases.ts --check   # CI drift guard
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  toV2OperationKey,
  V2_ALIAS_SUBJECT_PARAM_ALLOWED,
  V2_EXCLUDED_V1_OPERATIONS,
  V2_GUARDED_V1_OPERATIONS,
  V2_NATIVE_END_USER_OPERATION_KEYS,
} from "../src/lib/api-version/v2-surface";
import {
  API_V1_ROOT,
  API_V2_ROOT,
  collectRouteFiles,
  exportedHttpMethods,
  HTTP_METHODS,
  publicRouteOperations,
  routeKey,
  scanApiV1Routes,
  scanApiV2Routes,
} from "../src/lib/openapi/route-scan";
import { classifyOpenApiOperation } from "../src/lib/openapi/tags";

const GENERATED_MARKER = "@generated api-v2-alias";
const HEADER = `// ${GENERATED_MARKER} — do not edit. Source: src/lib/api-version/v2-surface.ts (npm run api:v2:generate)`;

/** v1 handlers that let M2M pick the billed end user from the query or body. */
const SUBJECT_PARAM_PATTERN =
  /\b(?:resolveWalletBillingTarget|resolveWalletRouteContext|readOptionalExternalUserId)\b/;

/** Route segment config must be declared literally in each route file. */
const SEGMENT_CONFIG_PATTERN =
  /^export const (?:dynamic|dynamicParams|revalidate|fetchCache|runtime|preferredRegion|maxDuration)\s*=.*;$/gm;

type Plan = { files: Map<string, string>; errors: string[] };

function isGenerated(source: string): boolean {
  return source.includes(GENERATED_MARKER);
}

function aliasSource(sourceFile: string, methods: string[]): string {
  const v1Source = readFileSync(join(API_V1_ROOT, sourceFile), "utf8");
  const segmentConfig = v1Source.match(SEGMENT_CONFIG_PATTERN) ?? [];
  const importPath = `@/app/api/v1/${sourceFile.replace(/\.ts$/, "")}`;
  const ordered = HTTP_METHODS.filter((method) => methods.includes(method));
  return [
    HEADER,
    `export { ${ordered.join(", ")} } from "${importPath}";`,
    ...segmentConfig,
    "",
  ].join("\n");
}

function buildPlan(): Plan {
  const errors: string[] = [];
  const methodsBySource = new Map<string, string[]>();

  for (const op of publicRouteOperations(scanApiV1Routes())) {
    // Builder / End-user only — Internal ops outside `/internal/` stay v1.
    const audience = classifyOpenApiOperation(op.method, op.path);
    if (audience !== "builder" && audience !== "end-user") {
      continue;
    }
    const key = routeKey(op.method, op.path);
    if (V2_EXCLUDED_V1_OPERATIONS.has(key) || V2_GUARDED_V1_OPERATIONS.has(key)) {
      continue;
    }
    const v1Source = readFileSync(join(API_V1_ROOT, op.sourceFile), "utf8");
    if (SUBJECT_PARAM_PATTERN.test(v1Source) && !V2_ALIAS_SUBJECT_PARAM_ALLOWED.has(key)) {
      errors.push(
        `${key} (${op.sourceFile}) lets M2M name the end user — add it to ` +
          "V2_GUARDED_V1_OPERATIONS or V2_EXCLUDED_V1_OPERATIONS in v2-surface.ts.",
      );
      continue;
    }
    const methods = methodsBySource.get(op.sourceFile) ?? [];
    methods.push(op.method.toUpperCase());
    methodsBySource.set(op.sourceFile, methods);
  }

  const files = new Map<string, string>();
  for (const [sourceFile, methods] of methodsBySource) {
    const target = join(API_V2_ROOT, sourceFile);
    if (existsSync(target) && !isGenerated(readFileSync(target, "utf8"))) {
      errors.push(
        `${target} is hand-written but ${methods.join("/")} should be aliased — ` +
          "move those methods into the hand-written file's guarded set or delete it.",
      );
      continue;
    }
    files.set(target, aliasSource(sourceFile, methods));
  }
  return { files, errors };
}

function existingGeneratedFiles(): string[] {
  if (!existsSync(API_V2_ROOT)) {
    return [];
  }
  return collectRouteFiles(API_V2_ROOT)
    .map((rel) => join(API_V2_ROOT, rel))
    .filter((file) => isGenerated(readFileSync(file, "utf8")));
}

/** Guarded wrappers and v2-only routes must exist as hand-written files. */
function verifyHandWrittenRoutes(): string[] {
  const v2Keys = new Set(
    scanApiV2Routes().map((op) => routeKey(op.method, op.path)),
  );
  const missing: string[] = [];
  for (const key of V2_GUARDED_V1_OPERATIONS.keys()) {
    const v2Key = toV2OperationKey(key);
    if (!v2Keys.has(v2Key)) {
      missing.push(`${v2Key} (guarded wrapper missing)`);
    }
  }
  for (const key of V2_NATIVE_END_USER_OPERATION_KEYS) {
    if (!v2Keys.has(key)) {
      missing.push(`${key} (v2-only route missing)`);
    }
  }
  return missing;
}

function pruneEmptyDirs(dir: string): void {
  if (dir === API_V2_ROOT || !dir.startsWith(API_V2_ROOT)) {
    return;
  }
  if (existsSync(dir) && readdirSync(dir).length === 0) {
    rmdirSync(dir);
    pruneEmptyDirs(dirname(dir));
  }
}

function main() {
  const check = process.argv.includes("--check");
  const { files, errors } = buildPlan();
  if (errors.length > 0) {
    console.error(`api v2 alias plan failed:\n  - ${errors.join("\n  - ")}`);
    process.exit(1);
  }

  const stale = existingGeneratedFiles().filter((file) => !files.has(file));
  const drifted = [...files].filter(
    ([file, content]) => !existsSync(file) || readFileSync(file, "utf8") !== content,
  );

  if (check) {
    const problems = [
      ...drifted.map(([file]) => `out of date: ${file}`),
      ...stale.map((file) => `stale: ${file}`),
      ...verifyHandWrittenRoutes(),
    ];
    if (problems.length > 0) {
      console.error(
        `api v2 aliases drifted (run npm run api:v2:generate):\n  - ${problems.join("\n  - ")}`,
      );
      process.exit(1);
    }
    console.log(`api v2 aliases up to date (${files.size} files).`);
    return;
  }

  for (const [file, content] of drifted) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
  }
  for (const file of stale) {
    rmSync(file);
    pruneEmptyDirs(dirname(file));
  }
  const missing = verifyHandWrittenRoutes();
  if (missing.length > 0) {
    console.error(`api v2 hand-written routes missing:\n  - ${missing.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    `api v2 aliases: ${files.size} files (${drifted.length} written, ${stale.length} removed).`,
  );
}

main();
