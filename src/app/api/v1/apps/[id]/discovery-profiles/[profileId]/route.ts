import { NextRequest, NextResponse } from "next/server";
import {
  appEditForbiddenResponse,
  canEditProviderApp,
  getAuthorizedProviderApp,
} from "@/domains/developer-apps/runtime/provider-access";
import {
  deleteDiscoveryProfile,
  DiscoveryProfileDuplicateNameError,
  getDiscoveryProfile,
  updateDiscoveryProfile,
} from "@/domains/plans-discovery/repo/discovery-profiles";
import { parseUpdateDiscoveryProfileInput } from "@/domains/plans-discovery/service/discovery-profile-input";
import {
  readDiscoveryProfile,
  resolveReadableDiscoveryProfilesApp,
} from "@/domains/plans-discovery/runtime/discovery-profiles-read";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; profileId: string }> },
) {
  const { id: clientId, profileId } = await params;
  const app = await resolveReadableDiscoveryProfilesApp(clientId, request);
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const profile = await readDiscoveryProfile(clientId, app.id, profileId);
  if (!profile) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ profile });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; profileId: string }> },
) {
  const { id: clientId, profileId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await canEditProviderApp(auth))) {
    return appEditForbiddenResponse();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const existing = await getDiscoveryProfile(auth.app.id, profileId);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = parseUpdateDiscoveryProfileInput(body, {
    name: existing.profile.name,
    policy: existing.profile.policy,
  });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const result = await updateDiscoveryProfile(auth.app.id, profileId, parsed.value);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
  } catch (error) {
    if (error instanceof DiscoveryProfileDuplicateNameError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; profileId: string }> },
) {
  const { id: clientId, profileId } = await params;
  const auth = await getAuthorizedProviderApp(clientId);
  if (!auth) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await canEditProviderApp(auth))) {
    return appEditForbiddenResponse();
  }

  const result = await deleteDiscoveryProfile(auth.app.id, profileId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ success: true });
}
