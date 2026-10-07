// v2: owner wallet only — M2M cannot name the end user (see v2-surface.ts).
import {
  GET as v1GET,
} from "@/app/api/v1/apps/[id]/billing/wallet/invoices/route";
import { withoutSubjectOverride } from "@/lib/api-version/v2-guards";

export const GET = withoutSubjectOverride(v1GET, "/invoices");
