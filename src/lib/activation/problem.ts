import { NextResponse } from "next/server";

import { createCorrelationId } from "@/lib/audit";
import {
  AppActivationError,
  type ActivationReason,
  type BillingMode,
} from "@/lib/activation/app-activation";

const PROBLEM_TYPE = "https://pymthouse.com/problems/app-not-activated";

export type ActivationProblemBody = {
  type: string;
  title: string;
  status: number;
  code: ActivationReason;
  billingMode: BillingMode;
  actionUrl: string;
  correlation_id: string;
  detail?: string;
};

const TITLE_BY_REASON: Record<ActivationReason, string> = {
  owner_balance_exhausted: "App cannot provision end users",
  end_user_cap_reached: "App cannot provision end users",
  stripe_connect_required: "Stripe Connect required",
  stripe_connect_pending: "Stripe Connect onboarding incomplete",
};

export function statusForActivationReason(reason: ActivationReason): number {
  return reason === "owner_balance_exhausted" ? 402 : 403;
}

export function buildActivationProblem(input: {
  reason: ActivationReason;
  billingMode: BillingMode;
  actionUrl: string;
  correlationId?: string;
  detail?: string;
}): ActivationProblemBody {
  const status = statusForActivationReason(input.reason);
  return {
    type: PROBLEM_TYPE,
    title: TITLE_BY_REASON[input.reason],
    status,
    code: input.reason,
    billingMode: input.billingMode,
    actionUrl: input.actionUrl,
    correlation_id: input.correlationId ?? createCorrelationId(),
    ...(input.detail ? { detail: input.detail } : {}),
  };
}

export function activationProblemResponse(input: {
  reason: ActivationReason;
  billingMode: BillingMode;
  actionUrl: string;
  correlationId?: string;
  detail?: string;
}): NextResponse {
  const body = buildActivationProblem(input);
  return NextResponse.json(body, {
    status: body.status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

/** Map AppActivationError → problem response; otherwise null. */
export function activationErrorResponse(err: unknown): NextResponse | null {
  if (!(err instanceof AppActivationError)) {
    return null;
  }
  return activationProblemResponse({
    reason: err.code,
    billingMode: err.billingMode,
    actionUrl: err.actionUrl,
    detail: err.message,
  });
}
