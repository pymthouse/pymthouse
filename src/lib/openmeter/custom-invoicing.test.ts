import test from "node:test";
import assert from "node:assert/strict";
import { customInvoicingRequestUrl } from "./custom-invoicing";

test("customInvoicingRequestUrl strips /api/v1 for Konnect bases", () => {
  const savedUrl = process.env.OPENMETER_URL;
  const savedKey = process.env.OPENMETER_API_KEY;
  process.env.OPENMETER_URL = "https://us.api.konghq.com/v3/openmeter";
  process.env.OPENMETER_API_KEY = "kpat_test";
  try {
    const url = customInvoicingRequestUrl(
      "01G65Z755AFWAKHE12NY0CQ9FH",
      "payment/status",
    );
    assert.equal(
      url,
      "https://us.api.konghq.com/v3/openmeter/apps/custom-invoicing/01G65Z755AFWAKHE12NY0CQ9FH/payment/status",
    );
  } finally {
    process.env.OPENMETER_URL = savedUrl;
    process.env.OPENMETER_API_KEY = savedKey;
  }
});

test("customInvoicingRequestUrl keeps /api/v1 for self-hosted", () => {
  const savedUrl = process.env.OPENMETER_URL;
  const savedKey = process.env.OPENMETER_API_KEY;
  process.env.OPENMETER_URL = "http://127.0.0.1:48888";
  delete process.env.OPENMETER_API_KEY;
  try {
    const url = customInvoicingRequestUrl(
      "01G65Z755AFWAKHE12NY0CQ9FH",
      "draft/synchronized",
    );
    assert.equal(
      url,
      "http://127.0.0.1:48888/api/v1/apps/custom-invoicing/01G65Z755AFWAKHE12NY0CQ9FH/draft/synchronized",
    );
  } finally {
    process.env.OPENMETER_URL = savedUrl;
    if (savedKey === undefined) {
      delete process.env.OPENMETER_API_KEY;
    } else {
      process.env.OPENMETER_API_KEY = savedKey;
    }
  }
});
