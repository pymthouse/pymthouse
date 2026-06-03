import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url?.trim()) {
    throw new Error(
      "DATABASE_URL is required. Set it to your PostgreSQL connection string (e.g. Neon).",
    );
  }
  return url.trim();
}

const globalForDb = globalThis as unknown as {
  pymthousePostgres?: ReturnType<typeof postgres>;
  pymthouseDb?: Db;
};

function getPostgresClient() {
  if (!globalForDb.pymthousePostgres) {
    globalForDb.pymthousePostgres = postgres(requireDatabaseUrl(), { max: 10 });
  }
  return globalForDb.pymthousePostgres;
}

function getDb(): Db {
  if (!globalForDb.pymthouseDb) {
    globalForDb.pymthouseDb = drizzle(getPostgresClient(), { schema });
  }
  return globalForDb.pymthouseDb;
}

/**
 * Lazy Drizzle client — does not connect until first query.
 * Avoids requiring DATABASE_URL during `next build` (page-data collection).
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    const instance = getDb();
    const value = Reflect.get(instance as object, prop, receiver);
    if (typeof value === "function") {
      return (value as (...args: unknown[]) => unknown).bind(instance);
    }
    return value;
  },
});

/** @deprecated Prefer `db`; lazy-initialized on first use. */
export const postgresClient = new Proxy({} as ReturnType<typeof postgres>, {
  get(_target, prop, receiver) {
    const instance = getPostgresClient();
    const value = Reflect.get(instance as object, prop, receiver);
    if (typeof value === "function") {
      return (value as (...args: unknown[]) => unknown).bind(instance);
    }
    return value;
  },
});
