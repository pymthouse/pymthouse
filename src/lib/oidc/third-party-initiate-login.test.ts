import test from "node:test";
import assert from "node:assert/strict";

import {
  issuerMatchesExpected,
  normalizeIssuerUrl,
  validateInitiateLoginUri,
  validateDeviceFlowTargetLinkUri,
  buildInitiateLoginRedirectUrl,
  deviceAuthVerificationUris,
  userCodeFromDeviceTargetLinkUri,
} from "./third-party-initiate-login";
import { thirdPartyInitiateSkipCookieName } from "./third-party-initiate-skip-cookie";
import { getIssuer, getPublicOrigin } from "./issuer-urls";

test("normalizeIssuerUrl trims trailing slashes", () => {
  assert.equal(
    normalizeIssuerUrl("https://op.example/api/v1/oidc/"),
    "https://op.example/api/v1/oidc",
  );
});

test("issuerMatchesExpected compares normalized issuers", () => {
  const iss = getIssuer();
  assert.equal(issuerMatchesExpected(iss, iss), true);
  assert.equal(issuerMatchesExpected("https://wrong.example", iss), false);
  assert.equal(issuerMatchesExpected(null, iss), false);
});

test("validateInitiateLoginUri accepts HTTPS without fragment", () => {
  assert.doesNotThrow(() =>
    validateInitiateLoginUri("https://rp.example/oidc/start"),
  );
});

test("validateInitiateLoginUri rejects fragments", () => {
  assert.throws(() => validateInitiateLoginUri("https://rp.example/start#frag"));
});

test("validateDeviceFlowTargetLinkUri enforces /oidc/device on public origin", () => {
  const origin = getPublicOrigin();
  const ok = `${origin}/oidc/device?user_code=ABCD-EFGH&client_id=app_x&iss=${encodeURIComponent(getIssuer())}`;
  assert.doesNotThrow(() => validateDeviceFlowTargetLinkUri(ok));
  assert.throws(() => validateDeviceFlowTargetLinkUri(`${origin}/login`));
});

test("thirdPartyInitiateSkipCookieName differs by user_code for same client", () => {
  const a = thirdPartyInitiateSkipCookieName("app_x", "ABCD-EFGH");
  const b = thirdPartyInitiateSkipCookieName("app_x", "WXYZ-1234");
  assert.notEqual(a, b);
  assert.equal(
    thirdPartyInitiateSkipCookieName("app_x", "abcd-efgh"),
    thirdPartyInitiateSkipCookieName("app_x", "ABCD-EFGH"),
  );
});

test("userCodeFromDeviceTargetLinkUri reads user_code query", () => {
  const origin = getPublicOrigin();
  const u = `${origin}/oidc/device?user_code=AA-BB&client_id=app_1`;
  assert.equal(userCodeFromDeviceTargetLinkUri(u), "AA-BB");
  assert.equal(userCodeFromDeviceTargetLinkUri("not-a-url"), undefined);
});

test("deviceAuthVerificationUris keeps verification_uri on the authorization server", () => {
  const uris = deviceAuthVerificationUris({
    userCode: "ABCD-EFGH",
    clientId: "app_x",
    issuer: getIssuer(),
    externalOrigin: "https://op.example",
    initiateLoginUri: "https://rp.example/device",
  });
  assert.equal(uris.verification_uri, "https://op.example/oidc/device");
});

test("deviceAuthVerificationUris targets the RP when the app federates approval", () => {
  const complete = deviceAuthVerificationUris({
    userCode: "ABCD-EFGH",
    clientId: "app_x",
    issuer: getIssuer(),
    externalOrigin: "https://op.example",
    initiateLoginUri: "https://rp.example/device",
  }).verification_uri_complete;

  assert.ok(complete);
  const url = new URL(complete);
  assert.equal(url.origin + url.pathname, "https://rp.example/device");
  assert.equal(url.searchParams.get("iss"), getIssuer());
  assert.equal(
    userCodeFromDeviceTargetLinkUri(
      url.searchParams.get("target_link_uri") ?? "",
    ),
    "ABCD-EFGH",
  );
});

test("deviceAuthVerificationUris falls back to the authorization server", () => {
  const base = {
    userCode: "ABCD-EFGH",
    clientId: "app_x",
    issuer: getIssuer(),
    externalOrigin: "https://op.example",
  };
  const expected = `https://op.example/oidc/device?user_code=ABCD-EFGH&client_id=app_x&iss=${encodeURIComponent(getIssuer())}`;

  // No third-party login configured for the app.
  assert.equal(
    deviceAuthVerificationUris({ ...base, initiateLoginUri: null })
      .verification_uri_complete,
    expected,
  );
  // Registered initiate_login_uri fails validation (plain HTTP, non-loopback).
  assert.equal(
    deviceAuthVerificationUris({
      ...base,
      initiateLoginUri: "http://rp.example/device",
    }).verification_uri_complete,
    expected,
  );
});

test("deviceAuthVerificationUris omits verification_uri_complete without a user_code", () => {
  const uris = deviceAuthVerificationUris({
    userCode: null,
    clientId: "app_x",
    issuer: getIssuer(),
    externalOrigin: "https://op.example",
    initiateLoginUri: "https://rp.example/device",
  });
  assert.equal(uris.verification_uri, "https://op.example/oidc/device");
  assert.equal(uris.verification_uri_complete, undefined);
});

test("buildInitiateLoginRedirectUrl validates both URIs", () => {
  const origin = getPublicOrigin();
  const target = `${origin}/oidc/device?foo=1`;
  const dest = buildInitiateLoginRedirectUrl("https://rp.example/start", {
    iss: getIssuer(),
    target_link_uri: target,
  });
  assert.match(dest, /^https:\/\/rp\.example\/start\?/);
  assert.ok(dest.includes("target_link_uri="));
});
