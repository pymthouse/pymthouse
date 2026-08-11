import test from "node:test";
import assert from "node:assert/strict";
import { rewriteKonnectPathname } from "./konnect-routes";

test("rewriteKonnectPathname maps custom-invoicing completion paths", () => {
  assert.equal(
    rewriteKonnectPathname(
      "/api/v1/apps/custom-invoicing/01G65Z755AFWAKHE12NY0CQ9FH/draft/synchronized",
      "POST",
    ),
    "/apps/custom-invoicing/01G65Z755AFWAKHE12NY0CQ9FH/draft/synchronized",
  );
  assert.equal(
    rewriteKonnectPathname(
      "/v3/openmeter/api/v1/apps/custom-invoicing/01G65Z755AFWAKHE12NY0CQ9FH/payment/status",
      "POST",
    ),
    "/v3/openmeter/apps/custom-invoicing/01G65Z755AFWAKHE12NY0CQ9FH/payment/status",
  );
});
