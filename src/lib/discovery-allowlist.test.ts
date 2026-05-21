import assert from "node:assert/strict";
import test from "node:test";

import {
  computeManifestRevision,
  excludedDocumentFromPickerValues,
  expandDocumentToConcreteKeys,
  fullCatalogConcreteKeys,
  isDiscoveryDocumentEmpty,
  normalizeDiscoveryAllowlistDoc,
  pickerValuesFromExcludedDocument,
  resolveDiscoveryCapabilitiesForExclusions,
  toAppManifestResponse,
} from "./discovery-allowlist";

const CATALOG = [
  { id: "pipe-a", models: ["m1", "m2"] },
  { id: "pipe-b", models: ["only"] },
];

test("normalizeDiscoveryAllowlistDoc trims and skips invalid rows", () => {
  const doc = normalizeDiscoveryAllowlistDoc({
    capabilities: [
      { pipeline: "  p ", modelId: " x " },
      {},
      { pipeline: "", modelId: "y" },
    ],
  });
  assert.deepEqual(doc, { capabilities: [{ pipeline: "p", modelId: "x" }] });
});

test("resolveDiscoveryCapabilitiesForExclusions: empty exclusions return full catalog", () => {
  const r = resolveDiscoveryCapabilitiesForExclusions(CATALOG, null);
  assert.deepEqual(r.capabilities, [
    { pipeline: "pipe-a", modelId: "m1" },
    { pipeline: "pipe-a", modelId: "m2" },
    { pipeline: "pipe-b", modelId: "only" },
  ]);
  assert.deepEqual(r.excludedCapabilities, []);
});

test("resolveDiscoveryCapabilitiesForExclusions: full catalog minus exclusions", () => {
  const r = resolveDiscoveryCapabilitiesForExclusions(CATALOG, {
    capabilities: [{ pipeline: "pipe-a", modelId: "m1" }],
  });
  assert.deepEqual(r.capabilities, [
    { pipeline: "pipe-a", modelId: "m2" },
    { pipeline: "pipe-b", modelId: "only" },
  ]);
  assert.deepEqual(r.excludedCapabilities, [
    { pipeline: "pipe-a", modelId: "m1" },
  ]);
});

test("resolveDiscoveryCapabilitiesForExclusions: pipeline wildcard exclusion", () => {
  const r = resolveDiscoveryCapabilitiesForExclusions(CATALOG, {
    capabilities: [{ pipeline: "pipe-a", modelId: "*" }],
  });
  assert.deepEqual(r.capabilities, [{ pipeline: "pipe-b", modelId: "only" }]);
});

test("expandDocumentToConcreteKeys ignores unknown pipeline/model", () => {
  const keys = expandDocumentToConcreteKeys(
    {
      capabilities: [
        { pipeline: "pipe-a", modelId: "m1" },
        { pipeline: "nope", modelId: "x" },
        { pipeline: "pipe-a", modelId: "bad" },
      ],
    },
    CATALOG,
  );
  assert.deepEqual([...keys].sort(), ["pipe-a|m1"]);
});

test("picker round-trip: excluded doc -> picker values -> excluded rows", () => {
  const excluded = {
    capabilities: [{ pipeline: "pipe-a", modelId: "m1" }],
  };
  const values = pickerValuesFromExcludedDocument(CATALOG, excluded);
  const back = excludedDocumentFromPickerValues(CATALOG, values);
  assert.deepEqual(back, excluded.capabilities);
});

test("excludedDocumentFromPickerValues collapses full pipeline to wildcard", () => {
  const values = pickerValuesFromExcludedDocument(CATALOG, {
    capabilities: [{ pipeline: "pipe-b", modelId: "*" }],
  });
  assert.deepEqual(values, ["pipe-a"]);
  const doc = excludedDocumentFromPickerValues(CATALOG, values);
  assert.deepEqual(doc, [{ pipeline: "pipe-b", modelId: "*" }]);
});

test("isDiscoveryDocumentEmpty treats missing capabilities as empty", () => {
  assert.equal(isDiscoveryDocumentEmpty(null), true);
  assert.equal(isDiscoveryDocumentEmpty({ capabilities: [] }), true);
});

test("fullCatalogConcreteKeys lists every pipeline|model", () => {
  assert.equal(fullCatalogConcreteKeys(CATALOG).size, 3);
});

test("toAppManifestResponse adds manifestVersion", () => {
  const resolved = resolveDiscoveryCapabilitiesForExclusions(CATALOG, null);
  const body = toAppManifestResponse(resolved);
  assert.equal(body.manifestVersion, computeManifestRevision(resolved));
});
