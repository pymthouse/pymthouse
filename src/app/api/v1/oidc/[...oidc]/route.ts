import { NextRequest, NextResponse } from "next/server";
import { handleOidcCatchall } from "@/domains/oidc-platform/runtime/provider-catchall";

export async function GET(request: NextRequest) {
  return handleOidcCatchall(request);
}

export async function POST(request: NextRequest) {
  return handleOidcCatchall(request);
}

export async function PUT(request: NextRequest) {
  return handleOidcCatchall(request);
}

export async function DELETE(request: NextRequest) {
  return handleOidcCatchall(request);
}

export async function OPTIONS(request: NextRequest) {
  return handleOidcCatchall(request);
}
