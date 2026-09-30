import assert from "node:assert/strict";
import test from "node:test";

import {
  filterButtonLabel,
  optionMatchesQuery,
  visibleFilterOptions,
  type AppFilterOption,
} from "@/components/AppFilterDropdown";

const ids: AppFilterOption[] = [
  { value: "eu_43eac8e3fe4dd854633da7a23fb", label: "eu_43eac8e3fe4dd854633da7a23fb" },
  { value: "eu_cb8da10f6dcc418d86e26a936ee", label: "eu_cb8da10f6dcc418d86e26a936ee" },
  { value: "e2e-merchant-01affcc-1787032125", label: "e2e-merchant-01affcc-1787032125" },
];

test("startsWith matches a full id or a prefix, not a middle or suffix fragment", () => {
  const id = ids[0]!;
  assert.equal(optionMatchesQuery(id, id.value, "startsWith"), true);
  assert.equal(optionMatchesQuery(id, "eu_43eac", "startsWith"), true);
  assert.equal(optionMatchesQuery(id, "EU_43", "startsWith"), true);
  assert.equal(optionMatchesQuery(id, "8e3fe4dd", "startsWith"), false);
  assert.equal(optionMatchesQuery(id, "a23fb", "startsWith"), false);
});

test("includes still matches a substring anywhere", () => {
  const id = ids[0]!;
  assert.equal(optionMatchesQuery(id, "8e3fe4dd", "includes"), true);
  assert.equal(optionMatchesQuery(id, "a23fb", "includes"), true);
});

test("visibleFilterOptions keeps original order of prefix matches", () => {
  const visible = visibleFilterOptions(ids, "eu_", "startsWith");
  assert.deepEqual(
    visible.map((o) => o.value),
    [ids[0]!.value, ids[1]!.value],
  );
  assert.deepEqual(visibleFilterOptions(ids, "e2e-", "startsWith"), [ids[2]]);
  assert.deepEqual(visibleFilterOptions(ids, "nope", "startsWith"), []);
});

test("filterButtonLabel middle-truncates a single selected id", () => {
  const long = ids[0]!.label;
  const shown = filterButtonLabel(ids, [ids[0]!.value], "No identities", "All identities", 24);
  assert.equal(shown.length, 24);
  assert.equal(shown.startsWith("eu_"), true);
  assert.equal(shown.endsWith(long.slice(-11)), true);
  assert.equal(
    filterButtonLabel(ids, ids.map((o) => o.value), "No identities", "All identities", 24),
    "All identities",
  );
});
