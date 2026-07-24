import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load `.env` then `.env.local` into `process.env` without overriding
 * variables already set in the shell (same idea as Next.js / dotenv).
 * `.env.local` wins over `.env` for the same key.
 */
export function loadDotenvFiles(cwd: string = process.cwd()) {
  const merged: Record<string, string> = {};
  for (const name of [".env", ".env.local"]) {
    const p = join(cwd, name);
    if (!existsSync(p)) continue;
    parseEnvInto(readFileSync(p, "utf-8"), merged);
  }
  for (const [k, v] of Object.entries(merged)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
    }
  }
}

function parseEnvInto(content: string, into: Record<string, string>) {
  for (let line of content.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) {
      line = line.slice(7).trim();
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    into[key] = val;
  }
}
