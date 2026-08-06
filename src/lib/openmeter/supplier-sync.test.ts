import test from "node:test";
import assert from "node:assert/strict";

import {
  buildKonnectSupplierAddress,
  buildOpenMeterSupplierAddress,
  requiresSupplierTaxId,
  supplierGaps,
  supplierIsComplete,
} from "./billing-supplier";
import {
  merchantSettlementMetadata,
  SETTLEMENT_CHARGE_MODEL_KEY,
  SETTLEMENT_CONNECT_ACCOUNT_KEY,
} from "./settlement-metadata";
import { resolveMerchantChargeModel } from "./supplier-sync";
import { __testMapAccountIdentity } from "@/lib/stripe/connect-accounts";

test("supplierGaps: US company needs no tax id", () => {
  assert.deepEqual(
    supplierGaps({ country: "US", name: "Acme LLC", taxId: null }),
    [],
  );
  assert.equal(
    supplierIsComplete({ country: "US", name: "Acme LLC", taxId: null }),
    true,
  );
});

test("supplierGaps: DE company needs tax id", () => {
  assert.deepEqual(
    supplierGaps({ country: "DE", name: "GmbH", taxId: null }),
    ["tax_id"],
  );
  assert.deepEqual(
    supplierGaps({ country: "DE", name: "GmbH", taxId: "DE123" }),
    [],
  );
});

test("supplierGaps: missing country and name", () => {
  assert.deepEqual(supplierGaps({}), ["country", "name"]);
});

test("Connect identity map clears country/name gaps (US)", () => {
  const identity = __testMapAccountIdentity({
    country: "US",
    details_submitted: true,
    company: {
      name: "Acme LLC",
      tax_id_provided: true,
      address: { country: "US", line1: "1 Main" },
    },
  });
  assert.equal(identity.country, "US");
  assert.equal(identity.legalName, "Acme LLC");
  assert.deepEqual(
    supplierGaps({
      country: identity.country,
      name: identity.legalName,
      taxId: null,
    }),
    [],
  );
});

test("requiresSupplierTaxId covers EU and commons", () => {
  assert.equal(requiresSupplierTaxId("de"), true);
  assert.equal(requiresSupplierTaxId("US"), false);
  assert.equal(requiresSupplierTaxId(null), false);
});

test("address builders omit null keys", () => {
  const om = buildOpenMeterSupplierAddress({
    country: "us",
    addressCity: "  ",
    addressLine1: "1 Main",
  });
  assert.deepEqual(om, { country: "US", line1: "1 Main" });

  const kn = buildKonnectSupplierAddress({
    country: "DE",
    addressPostalCode: "10115",
  });
  assert.deepEqual(kn, { country: "DE", postal_code: "10115" });
});

test("mapAccountIdentity prefers company name and address", () => {
  const id = __testMapAccountIdentity({
    country: "de",
    business_type: "company",
    details_submitted: true,
    company: {
      name: "Acme GmbH",
      address: {
        line1: "Friedrichstr. 1",
        city: "Berlin",
        postal_code: "10117",
      },
      vat_id_provided: true,
    },
    individual: {
      first_name: "A",
      last_name: "B",
      address: { line1: "Home" },
    },
  });
  assert.equal(id.country, "DE");
  assert.equal(id.legalName, "Acme GmbH");
  assert.equal(id.addressLine1, "Friedrichstr. 1");
  assert.equal(id.taxIdProvided, true);
});

test("mapAccountIdentity falls back to individual name", () => {
  const id = __testMapAccountIdentity({
    country: "US",
    business_type: "individual",
    details_submitted: true,
    individual: { first_name: "Jane", last_name: "Doe" },
  });
  assert.equal(id.legalName, "Jane Doe");
});

test("resolveMerchantChargeModel gates direct on supplier completeness", () => {
  assert.equal(
    resolveMerchantChargeModel({
      supplierCountry: "US",
      supplierName: "Acme",
      supplierTaxId: null,
    }),
    "direct",
  );
  assert.equal(
    resolveMerchantChargeModel({
      supplierCountry: "DE",
      supplierName: "GmbH",
      supplierTaxId: null,
    }),
    "destination",
  );
});

test("merchantSettlementMetadata stamps settlement keys", () => {
  const meta = merchantSettlementMetadata({
    connectedAccountId: "acct_123",
    chargeModel: "direct",
  });
  assert.equal(meta[SETTLEMENT_CHARGE_MODEL_KEY], "direct");
  assert.equal(meta[SETTLEMENT_CONNECT_ACCOUNT_KEY], "acct_123");
});
