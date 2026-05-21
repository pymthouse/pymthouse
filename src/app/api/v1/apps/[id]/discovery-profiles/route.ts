import { NextRequest, NextResponse } from "next/server";
import {
  appEditForbiddenResponse,
  canEditProviderApp,
  getAuthorizedProviderApp,
} from "@/domains/developer-apps/runtime/provider-access";
import {
  createDiscoveryProfile,
  DiscoveryProfileDuplicateNameError,
} from "@/domains/plans-discovery/repo/discovery-profiles";
import { parseCreateDiscoveryProfileInput } from "@/domains/plans-discovery/service/discovery-profile-input";
import {
  readDiscoveryProfiles,
  resolveReadableDiscoveryProfilesApp,
} from "@/domains/plans-discovery/runtime/discovery-profiles-read";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const app = await resolveReadableDiscoveryProfilesApp(clientId, request);
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ profiles: await readDiscoveryProfiles(clientId, app.id) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
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

  const parsed = parseCreateDiscoveryProfileInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const profileId = await createDiscoveryProfile(auth.app.id, parsed.value);
    return NextResponse.json({ id: profileId }, { status: 201 });
  } catch (error) {
    if (error instanceof DiscoveryProfileDuplicateNameError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
