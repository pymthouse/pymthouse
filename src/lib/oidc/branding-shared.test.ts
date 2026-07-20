import assert from "node:assert/strict";
import test from "node:test";

import {
  getBrandingCssVars,
  getDefaultBranding,
  shouldUseWhiteLabelBranding,
} from "./branding-shared";

test("getDefaultBranding returns black-label defaults", () => {
  const branding = getDefaultBranding();
  assert.equal(branding.mode, "blackLabel");
  assert.equal(branding.primaryColor, "#10b981");
  assert.equal(shouldUseWhiteLabelBranding(branding), false);
});

test("getBrandingCssVars derives hover/muted from primary color", () => {
  const vars = getBrandingCssVars({
    ...getDefaultBranding(),
    primaryColor: "#112233",
  });
  assert.equal(vars["--branding-primary"], "#112233");
  assert.equal(vars["--branding-primary-muted"], "#1122331a");
  assert.match(vars["--branding-primary-hover"] ?? "", /^#[0-9a-f]{6}$/);
});

test("getBrandingCssVars falls back for invalid hex", () => {
  const vars = getBrandingCssVars({
    ...getDefaultBranding(),
    primaryColor: "not-a-color",
  });
  assert.equal(vars["--branding-primary"], "#10b981");
});
