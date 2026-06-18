/**
 * Resolution of the OpenMeter admin client for the subscription-backed
 * `/api/v1/auth/validate` (BPP ②) path, with a test-only injection seam.
 *
 * Lives outside the route module because Next.js route files may only export
 * recognized handlers (GET/POST/etc.) — a stray export breaks the generated
 * route types. Production behavior is unchanged from the original inline check:
 * the subscription branch runs only when OpenMeter usage reads are enabled AND a
 * hosted admin client is reachable; otherwise the legacy key is rejected.
 */

import type { OpenMeter } from "@openmeter/sdk";
import { getHostedAdminClient, isHostedAdminClientAvailable } from "./admin-client";
import { requireOpenMeterForUsageReads } from "./constants";

let testAdminClientResolver:
  | (() => { available: boolean; client: OpenMeter } | null)
  | null = null;

/**
 * Test-only override for the admin-client resolution. The hosted admin client is
 * intentionally unavailable in NODE_ENV=test, so tests use this to drive the
 * subscription-backed validate branch deterministically without a live
 * OpenMeter instance. Always `null` (inert) in production.
 */
export function __setValidateAdminClientForTests(
  resolver: (() => { available: boolean; client: OpenMeter } | null) | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setValidateAdminClientForTests is only available in test");
  }
  testAdminClientResolver = resolver;
}

/**
 * Resolve the OpenMeter admin client for the subscription-backed validate path,
 * or `null` when OpenMeter is unavailable (hard cutover → reject the key).
 */
export function resolveValidateAdminClient(): OpenMeter | null {
  if (testAdminClientResolver) {
    const override = testAdminClientResolver();
    return override?.available ? override.client : null;
  }
  if (requireOpenMeterForUsageReads() && isHostedAdminClientAvailable()) {
    return getHostedAdminClient();
  }
  return null;
}
