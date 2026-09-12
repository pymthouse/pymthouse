import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  oauthProviderIdForMethod,
  signInMethodStatuses,
} from "@/lib/turnkey-sign-in-methods";

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
      methods.map((m) => [m.id, m.linked, m.canAdd, m.removable]),
      [
        ["google", true, true, true],
        ["github", true, true, true],
        ["discord", false, true, false],
        ["email", true, false, true],
        ["passkey", false, false, false],
      ],
    );
  });

  it("does not let the last credential be removed", () => {
    const methods = signInMethodStatuses({
      user: {
        userEmail: "you@example.com",
        oauthProviders: [],
        authenticators: [],
      },
      googleEnabled: true,
      githubEnabled: true,
      discordEnabled: false,
    });
    const email = methods.find((m) => m.id === "email");
    assert.equal(email?.linked, true);
    assert.equal(email?.removable, false);
  });

  it("handles a user with no Turnkey profile yet", () => {
    const methods = signInMethodStatuses({
      user: null,
      googleEnabled: false,
      githubEnabled: false,
      discordEnabled: false,
    });
    assert.equal(methods.every((m) => !m.linked && !m.removable), true);
    assert.equal(methods.filter((m) => m.canAdd).length, 0);
  });
});

describe("oauthProviderIdForMethod", () => {
  it("returns the matching provider id", () => {
    const providers = [
      {
        providerId: "gp-1",
        providerName: "Google",
        issuer: "https://accounts.google.com",
      },
      { providerId: "gh-1", providerName: "GitHub" },
    ];
    assert.equal(oauthProviderIdForMethod(providers, "google"), "gp-1");
    assert.equal(oauthProviderIdForMethod(providers, "github"), "gh-1");
    assert.equal(oauthProviderIdForMethod(providers, "discord"), null);
    assert.equal(oauthProviderIdForMethod(providers, "email"), null);
  });
});
