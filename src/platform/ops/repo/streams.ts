import { db } from "@/db/index";
import { streamSessions } from "@/db/schema";

export async function listAllStreamSessions() {
  return db.select().from(streamSessions);
}
