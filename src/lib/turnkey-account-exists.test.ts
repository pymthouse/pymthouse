import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isTurnkeyAccountAlreadyExistsError,
  oauthAccountExistsMessage,
} from "./turnkey-account-exists";

describe("isTurnkeyAccountAlreadyExistsError", () => {
  it("matches Turnkey's addOauthProvider duplicate identity error", () => {
    assert.equal(
      isTurnkeyAccountAlreadyExistsError({
        code: "ACCOUNT_ALREADY_EXISTS",
        message: "Account already exists with this OIDC token or claims",
      }),
      true,
    );
    assert.equal(
      isTurnkeyAccountAlreadyExistsError(
        "Account already exists with this OIDC token or claims",
      ),
      true,
    );
    assert.equal(isTurnkeyAccountAlreadyExistsError("Failed to fetch user"), false);
  });

  it("names the provider in the account-settings copy", () => {
    assert.match(oauthAccountExistsMessage("discord"), /^Discord /);
    assert.match(oauthAccountExistsMessage(null), /This sign-in method /);
  });
});
