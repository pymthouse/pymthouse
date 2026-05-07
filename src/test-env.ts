const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

/**
 * Loaded before tests so modules that import `@/db/index` can initialize without
 * throwing when DATABASE_URL is unset (e.g. CI / local `npm test`).
 *
 * Match the local script behavior by reading `.env` and `.env.local` first. If
 * no database URL exists after that, keep a dummy URL only for module import
 * safety and mark it so DB-backed tests can skip instead of trying to connect as
 * the OS user.
 */
const mutableEnv = process.env as Record<string, string | undefined>;
mutableEnv.NODE_ENV ??= "test";
loadDotenvFiles();

process.env.AUTH_TOKEN_PEPPER ??=
  "test-auth-token-pepper-00000000000000000000000000000000";
process.env.NEXTAUTH_SECRET ??=
  "test-nextauth-secret-00000000000000000000000000000000";

if (!process.env.DATABASE_URL?.trim()) {
  process.env.PYMTHOUSE_TEST_DATABASE_URL_UNSET = "1";
  process.env.DATABASE_URL = "postgresql://127.0.0.1:5432/pymthouse_test_unset";
}

function loadDotenvFiles(cwd: string = process.cwd()) {
  const merged: Record<string, string> = {};
  for (const name of [".env", ".env.local"]) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    parseEnvInto(readFileSync(path, "utf-8"), merged);
  }
  for (const [key, value] of Object.entries(merged)) {
    process.env[key] ??= value;
  }
}

function parseEnvInto(content: string, into: Record<string, string>) {
  for (let line of content.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    into[key] = value;
  }
}
