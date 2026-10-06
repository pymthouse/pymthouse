/**
 * Bound zod 4 array parsing until upstream ships a fix for SNYK-JS-ZOD-20510278.
 *
 * `$ZodArray` allocates one issue per failing element and walks `input.length`,
 * so a large or sparse invalid array can exhaust memory. This rewrites the
 * installed 4.6.5 build (ESM and CJS) to reject arrays longer than 100_000
 * and to keep at most 100 issues. Idempotent. CI installs with
 * `--ignore-scripts`, so Next loads this from `next.config.ts` and `npm test`
 * runs it before the suite.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MARKER = "pymthouse:zod-array-cap";
const MAX_ARRAY_LENGTH = 100_000;
const MAX_ARRAY_ISSUES = 100;

const FILES = [
  "node_modules/zod/v4/core/schemas.js",
  "node_modules/zod/v4/core/schemas.cjs",
];

const OLD_HANDLE = `function handleArrayResult(result, final, index) {
    if (result.issues.length) {
        final.issues.push(...util.prefixIssues(index, result.issues));
    }
    final.value[index] = result.value;
}`;

const NEW_HANDLE = `function handleArrayResult(result, final, index) {
    // ${MARKER} — bound issue lists (SNYK-JS-ZOD-20510278)
    if (result.issues.length && final.issues.length < ${MAX_ARRAY_ISSUES}) {
        const room = ${MAX_ARRAY_ISSUES} - final.issues.length;
        final.issues.push(...util.prefixIssues(index, result.issues).slice(0, room));
    }
    final.value[index] = result.value;
}`;

const OLD_ALLOC =
  "        payload.value = memo ? memo.alloc(inst, payload, Array(input.length), ctx) : Array(input.length);";

const NEW_ALLOC = `        if (input.length > ${MAX_ARRAY_LENGTH}) {
            payload.issues.push({
                code: "too_big",
                origin: "array",
                maximum: ${MAX_ARRAY_LENGTH},
                inclusive: true,
                input,
                inst,
            });
            return payload;
        }
        payload.value = memo ? memo.alloc(inst, payload, Array(input.length), ctx) : Array(input.length);`;

function patchFile(relativePath) {
  const filePath = path.join(process.cwd(), relativePath);
  const source = readFileSync(filePath, "utf8");
  if (source.includes(MARKER)) return "already-patched";
  if (!source.includes(OLD_HANDLE) || !source.includes(OLD_ALLOC)) {
    throw new Error(
      `${relativePath} does not match zod 4.6.5 array parsing. ` +
        "Update scripts/patch-zod-array-bounds.mjs before bumping zod.",
    );
  }
  const next = source.replace(OLD_HANDLE, NEW_HANDLE).replace(OLD_ALLOC, NEW_ALLOC);
  if (next === source || !next.includes(MARKER)) {
    throw new Error(`Failed to patch ${relativePath}`);
  }
  writeFileSync(filePath, next);
  return "patched";
}

for (const file of FILES) {
  console.log(`${patchFile(file)} ${file}`);
}
