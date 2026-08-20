import assert from "node:assert/strict";
import test from "node:test";

import {
  mapInteractionPayload,
  oidcInteractionCompletePath,
} from "@/lib/oidc/interaction-bridge";

test("oidcInteractionCompletePath is a document navigation, not an RSC fetch", () => {
  assert.equal(
    oidcInteractionCompletePath("W4hYOpuBXFIF3QMENLmR_86c9UGx-ysRiko5YKbvxs7"),
    "/api/v1/oidc/interaction/W4hYOpuBXFIF3QMENLmR_86c9UGx-ysRiko5YKbvxs7?complete=1",
  );
});

test("mapInteractionPayload reads prompt and params", () => {
  const details = mapInteractionPayload(
    "uid-1",
    {
      uid: "uid-1",
      exp: 4_000_000_000,
      prompt: { name: "consent", details: { missingOIDCScope: ["email"] } },
      params: {
        client_id: "dcr_abc",
        redirect_uri: "http://localhost:52657/callback",
      },
      session: { accountId: "user-1" },
    },
    "MCP Connector",
    1_700_000_000_000,
  );
  assert.deepEqual(details, {
    uid: "uid-1",
    prompt: { name: "consent", details: { missingOIDCScope: ["email"] } },
    params: {
      client_id: "dcr_abc",
      redirect_uri: "http://localhost:52657/callback",
    },
    session: { accountId: "user-1" },
    clientName: "MCP Connector",
  });
});

test("mapInteractionPayload rejects expired interactions", () => {
  assert.equal(
    mapInteractionPayload(
      "uid-1",
      {
        exp: 1_700,
        prompt: { name: "login", details: {} },
        params: {},
      },
      undefined,
      1_700_000_001,
    ),
    null,
  );
});

test("mapInteractionPayload rejects payloads without a prompt name", () => {
  assert.equal(
    mapInteractionPayload("uid-1", { params: { client_id: "dcr_abc" } }),
    null,
  );
});
