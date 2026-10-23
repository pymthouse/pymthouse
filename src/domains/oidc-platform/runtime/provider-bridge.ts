import type { NextRequest } from "next/server";
import { IncomingMessage, ServerResponse } from "http";
import { Socket } from "net";
import { OIDC_MOUNT_PATH, getPublicOrigin } from "@/platform/oidc/issuer-urls";

export function buildProviderNodeRequest(params: {
  method: "GET" | "POST";
  request: NextRequest;
  path: string;
}) {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = params.method;
  req.url = `${OIDC_MOUNT_PATH}${params.path}`;
  params.request.headers.forEach((value, key) => {
    req.headers[key.toLowerCase()] = value;
  });
  const publicUrl = new URL(getPublicOrigin());
  req.headers.host = publicUrl.host;
  if (!req.headers["x-forwarded-proto"]) {
    req.headers["x-forwarded-proto"] = publicUrl.protocol.replace(":", "");
  }
  req.push(null);
  const res = new ServerResponse(req);
  return { req, res };
}
