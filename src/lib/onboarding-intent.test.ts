import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isOnboardingPersona,
  loginUrlForPersona,
  onboardingResumePath,
} from "./onboarding-intent";

describe("onboarding-intent", () => {
  it("accepts explorer and builder only", () => {
    assert.equal(isOnboardingPersona("explorer"), true);
    assert.equal(isOnboardingPersona("builder"), true);
    assert.equal(isOnboardingPersona("admin"), false);
    assert.equal(isOnboardingPersona(null), false);
  });

  it("builds resume and login URLs", () => {
    assert.equal(onboardingResumePath("explorer"), "/onboarding?persona=explorer");
    assert.equal(
      loginUrlForPersona("builder"),
      `/login?callbackUrl=${encodeURIComponent("/onboarding?persona=builder")}`,
    );
  });
});
