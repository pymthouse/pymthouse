import { redirect } from "next/navigation";

/** Dashboard merged into My Apps — keep /dashboard bookmarks working. */
export default function DashboardPage() {
  redirect("/apps");
}
