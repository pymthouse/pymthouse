// v2: owner wallet only — M2M cannot name the end user (see v2-surface.ts).
import {
  GET as v1GET,
  POST as v1POST,
} from "@/app/api/v1/apps/[id]/billing/wallet/payment-methods/route";
import { withoutSubjectOverride } from "@/lib/api-version/v2-guards";

export const GET = withoutSubjectOverride(v1GET, "/payment-methods");
export const POST = withoutSubjectOverride(v1POST, "/payment-methods");
