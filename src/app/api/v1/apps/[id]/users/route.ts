import { NextRequest, NextResponse } from "next/server";
import {
  createOrUpdateAppUser,
  deactivateExistingAppUser,
  readAppUsers,
  updateExistingAppUser,
} from "@/domains/developer-apps/runtime/app-users";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const result = await readAppUsers(request, clientId);
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const result = await createOrUpdateAppUser(request, clientId, await request.json());
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body, { status: result.status });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const result = await updateExistingAppUser(request, clientId, await request.json());
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: clientId } = await params;
  const { searchParams } = new URL(request.url);
  const result = await deactivateExistingAppUser(
    request,
    clientId,
    searchParams.get("externalUserId"),
  );
  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}
