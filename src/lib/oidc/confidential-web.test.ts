import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isConfidentialWebAuthMethod,
  isWebClientId,
  stripConfidentialWebIncompatibleGrants,
  syncConfidentialWebGrantTypes,
  validateConfidentialWebShape,
} from "./confidential-web";

describe("isConfidentialWebAuthMethod", () => {
  it("accepts client_secret_post and client_secret_basic", () => {
    assert.equal(isConfidentialWebAuthMethod("client_secret_post"), true);
    assert.equal(isConfidentialWebAuthMethod("client_secret_basic"), true);
  });

  it("rejects none and unknown", () => {
    assert.equal(isConfidentialWebAuthMethod("none"), false);
    assert.equal(isConfidentialWebAuthMethod(undefined), false);
    assert.equal(isConfidentialWebAuthMethod("bogus"), false);
  });
});

describe("isWebClientId", () => {
  it("matches web_ prefix", () => {
    assert.equal(isWebClientId("web_abc"), true);
    assert.equal(isWebClientId("app_abc"), false);
    assert.equal(isWebClientId("m2m_abc"), false);
  });
});

describe("validateConfidentialWebShape", () => {
  const valid = {
    tokenEndpointAuthMethod: "client_secret_post",
    redirectUris: ["https://portal.example.com/login"],
    grantTypes: ["authorization_code", "refresh_token"],
  };

  it("accepts a valid confidential web sibling shape", () => {
    assert.equal(validateConfidentialWebShape(valid), null);
  });

  it("allows empty redirects when authorization_code is absent", () => {
    assert.equal(
      validateConfidentialWebShape({
        ...valid,
        redirectUris: [],
        grantTypes: ["refresh_token"],
      }),
      null,
    );
  });

  it("requires redirect URIs when authorization_code is present", () => {
    const err = validateConfidentialWebShape({
      ...valid,
      redirectUris: [],
    });
    assert.equal(err?.error, "confidential_web_invalid_shape");
    assert.match(err!.error_description, /redirect URI/i);
  });

  it("requires redirect URIs when requireRedirects is set", () => {
    const err = validateConfidentialWebShape(
      {
        ...valid,
        redirectUris: [],
        grantTypes: ["refresh_token"],
      },
      { requireRedirects: true },
    );
    assert.equal(err?.error, "confidential_web_invalid_shape");
  });

  it("rejects client_credentials", () => {
    const err = validateConfidentialWebShape({
      ...valid,
      grantTypes: ["authorization_code", "client_credentials"],
    });
    assert.equal(err?.error, "confidential_web_invalid_shape");
    assert.match(err!.error_description, /client_credentials/i);
  });

  it("rejects device grant", () => {
    const err = validateConfidentialWebShape({
      ...valid,
      grantTypes: [
        "authorization_code",
        "urn:ietf:params:oauth:grant-type:device_code",
      ],
    });
    assert.equal(err?.error, "confidential_web_invalid_shape");
    assert.match(err!.error_description, /device flow/i);
  });

  it("rejects public auth method", () => {
    const err = validateConfidentialWebShape({
      ...valid,
      tokenEndpointAuthMethod: "none",
    });
    assert.equal(err?.error, "confidential_web_invalid_shape");
  });
});

describe("stripConfidentialWebIncompatibleGrants", () => {
  it("removes client_credentials and device grants", () => {
    assert.deepEqual(
      stripConfidentialWebIncompatibleGrants([
        "authorization_code",
        "refresh_token",
        "client_credentials",
        "urn:ietf:params:oauth:grant-type:device_code",
      ]),
      ["authorization_code", "refresh_token"],
    );
  });
});

describe("syncConfidentialWebGrantTypes", () => {
  it("adds authorization_code when redirects exist", () => {
    assert.deepEqual(
      syncConfidentialWebGrantTypes(
        ["refresh_token"],
        ["https://example.com/login"],
      ),
      ["authorization_code", "refresh_token"],
    );
  });

  it("removes authorization_code when redirects are empty", () => {
    assert.deepEqual(
      syncConfidentialWebGrantTypes(
        ["authorization_code", "refresh_token"],
        [],
      ),
      ["refresh_token"],
    );
  });
});
