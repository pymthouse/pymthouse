import { handleEndUserMeWalletGet } from "@/lib/billing/end-user-me-billing-handlers";
import { createAppScopedGet } from "@/lib/http/app-scoped-get";

export const GET = createAppScopedGet(handleEndUserMeWalletGet);
