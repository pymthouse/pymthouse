import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildOpenApiDocument } from "@/lib/openapi/document";
import "@/lib/openapi/routes";

const snapshotPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "__snapshots__/openapi-document.snapshot.json",
);

test("buildOpenApiDocument produces OpenAPI 3.1 with credential routes", () => {
  const doc = buildOpenApiDocument();
  assert.equal(doc.openapi, "3.1.0");
  assert.ok(doc.paths["/api/v1/apps/{clientId}/auth/api-key/token"]);
  assert.ok(doc.paths["/api/v1/apps/{clientId}/auth/api-key/signer-session"]);
  assert.ok(doc.components?.securitySchemes?.bearerApiKey);
  assert.ok(doc.components?.securitySchemes?.m2mBasic);

  const serialized = `${JSON.stringify(doc, null, 2)}\n`;
  if (!existsSync(dirname(snapshotPath))) {
    mkdirSync(dirname(snapshotPath), { recursive: true });
  }
  if (process.env.UPDATE_OPENAPI_SNAPSHOT === "1") {
    writeFileSync(snapshotPath, serialized, "utf8");
    return;
  }
  if (!existsSync(snapshotPath)) {
    writeFileSync(snapshotPath, serialized, "utf8");
  }
  const expected = readFileSync(snapshotPath, "utf8");
  assert.equal(serialized, expected);
});
