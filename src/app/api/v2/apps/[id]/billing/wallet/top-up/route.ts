// v2: owner wallet only — M2M cannot name the end user (see v2-surface.ts).
import {
  POST as v1POST,
} from "@/app/api/v1/apps/[id]/billing/wallet/top-up/route";
import { withoutSubjectOverride } from "@/lib/api-version/v2-guards";

export const POST = withoutSubjectOverride(v1POST, "/wallet/top-up");
