// v2: owner wallet only — M2M cannot name the end user (see v2-surface.ts).
import {
  GET as v1GET,
  PATCH as v1PATCH,
} from "@/app/api/v1/apps/[id]/billing/wallet/route";
import { withoutSubjectOverride } from "@/lib/api-version/v2-guards";

export const GET = withoutSubjectOverride(v1GET, "/wallet");
export const PATCH = withoutSubjectOverride(v1PATCH, "/wallet");
