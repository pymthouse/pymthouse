import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signInMethodStatuses } from "@/lib/turnkey-sign-in-methods";

describe("signInMethodStatuses", () => {
  it("marks linked providers from name or issuer and treats email/passkey as status-only", () => {
    const methods = signInMethodStatuses({
      user: {
        userEmail: "you@example.com",
        oauthProviders: [
          { providerName: "Google", issuer: "https://accounts.google.com" },
          {
            providerName: "GitHub",
            issuer: "https://pymthouse.com/api/v1/turnkey-github-oidc",
          },
        ],
        authenticators: [],
      },
      googleEnabled: true,
      githubEnabled: true,
      discordEnabled: true,
    });

    assert.deepEqual(
      methods.map((m) => [m.id, m.linked, m.canAdd]),
      [
        ["google", true, true],
        ["github", true, true],
        ["discord", false, true],
        ["email", true, false],
        ["passkey", false, false],
      ],
    );
  });

  it("handles a user with no Turnkey profile yet", () => {
    const methods = signInMethodStatuses({
      user: null,
      googleEnabled: false,
      githubEnabled: false,
      discordEnabled: false,
    });
    assert.equal(methods.every((m) => !m.linked), true);
    assert.equal(methods.filter((m) => m.canAdd).length, 0);
  });
});
