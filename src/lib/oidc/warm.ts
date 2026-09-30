/**
 * Keep-warm helpers for OIDC serverless functions.
 *
 * Each Vercel route is a separate isolate with its own module cache, so
 * warming `/api/v1/oidc/jwks` does not warm `/oidc/consent`. The catch-all
 * `/warm` handler also pings the page entrypoints so login/consent stay hot.
 */

import { timingSafeEqual } from "node:crypto";

import { getProvider } from "@/lib/oidc/provider";
import { getPublicOrigin } from "@/lib/oidc/issuer-urls";

function bearerMatchesSecret(authorization: string | null, secret: string): boolean {
  const expected = `Bearer ${secret}`;
  const provided = authorization ?? "";
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}

export function isTrustedOidcWarmRequest(headers: Headers): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return false;
  }
  return bearerMatchesSecret(headers.get("authorization"), secret);
}

export async function warmOidcProvider(): Promise<{ ok: true; issuer: string }> {
  const provider = await getProvider();
  return {
    ok: true,
    issuer: provider.issuer,
  };
}

/**
 * Fan-out keep-warm to the OIDC RSC pages (separate Vercel isolates).
 * Best-effort — failures must not fail the primary API warm.
 */
export async function warmOidcPageIsolates(): Promise<{
  interaction: number;
  consent: number;
}> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return { interaction: 0, consent: 0 };
  }

  const origin = getPublicOrigin();
  const headers: Record<string, string> = {
    "user-agent": "pymthouse-oidc-warm/1.0",
    authorization: `Bearer ${secret}`,
  };

  const [interaction, consent] = await Promise.all([
    fetch(`${origin}/oidc/interaction?warm=1`, {
      headers,
      cache: "no-store",
    })
      .then((r) => r.status)
      .catch(() => 0),
    fetch(`${origin}/oidc/consent?warm=1`, {
      headers,
      cache: "no-store",
    })
      .then((r) => r.status)
      .catch(() => 0),
  ]);

  return { interaction, consent };
}
