import { db } from "@/db/index";
import { streamSessions, transactions } from "@/db/schema";

export async function listSignerStreamSessions() {
  return db.select().from(streamSessions);
}

export async function listSignerTransactionIds() {
  return db.select({ id: transactions.id }).from(transactions);
}
