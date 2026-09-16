import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  accountSessionBindingMessage,
  requireAccountSessionBinding,
} from "@/lib/account-session-binding-client";

describe("requireAccountSessionBinding", () => {
  it("posts the live Turnkey session for server-side comparison", async () => {
    const priorFetch = globalThis.fetch;
    let requestBody = "";
    globalThis.fetch = async (_input, init) => {
      requestBody = String(init?.body ?? "");
      return Response.json({ bound: true });
    };
    try {
      await requireAccountSessionBinding(async () => ({
        token: " signed.session.jwt ",
      }));
    } finally {
      globalThis.fetch = priorFetch;
    }
    assert.deepEqual(JSON.parse(requestBody), {
      turnkeySessionJwt: "signed.session.jwt",
    });
  });

  it("surfaces a mismatched-wallet rejection", async () => {
    const priorFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json(
        { error: "The active wallet belongs to a different account." },
        { status: 409 },
      );
    try {
      await assert.rejects(
        requireAccountSessionBinding(async () => ({
          token: "signed.session.jwt",
        })),
        /different account/,
      );
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("requires a live Turnkey session before calling the API", async () => {
    await assert.rejects(
      requireAccountSessionBinding(async () => null),
      /live Turnkey session/,
    );
  });
});

describe("accountSessionBindingMessage", () => {
  it("explains missing and mismatched sessions", () => {
    assert.match(
      accountSessionBindingMessage(false, {
        status: "idle",
        error: null,
      }),
      /Sign in again/,
    );
    assert.equal(
      accountSessionBindingMessage(true, {
        status: "unbound",
        error: "Wrong wallet",
      }),
      "Wrong wallet",
    );
  });
});
