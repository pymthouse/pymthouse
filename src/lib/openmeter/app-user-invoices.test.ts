import assert from "node:assert/strict";
import test from "node:test";

import { getAppUserInvoice, listAppUserInvoices } from "./invoices";

test("listAppUserInvoices returns empty for blank ids", async () => {
  const client = {
    customers: { list: async () => ({ items: [] }) },
    billing: { invoices: { list: async () => ({ items: [] }) } },
  };
  const result = await listAppUserInvoices({
    client: client as never,
    clientId: "  ",
    externalUserId: "user_1",
  });
  assert.deepEqual(result, {
    items: [],
    page: 1,
    pageSize: 20,
    totalCount: 0,
  });
});

test("listAppUserInvoices lists invoices for the ensured customer", async () => {
  const listedCustomers: string[][] = [];
  const client = {
    billing: {
      invoices: {
        list: async (input: { customers: string[] }) => {
          listedCustomers.push([...input.customers]);
          return {
            items: [
              {
                id: "inv_1",
                number: "N-1",
                status: "issued",
                currency: "USD",
                totals: { total: "9.00" },
                customer: { id: "cust_eu", key: "app_1:user_1" },
                issuedAt: new Date("2026-07-01T00:00:00.000Z"),
              },
            ],
          };
        },
      },
    },
  };

  const result = await listAppUserInvoices({
    client: client as never,
    clientId: "app_1",
    externalUserId: "user_1",
    page: 1,
    pageSize: 10,
    ensureCustomer: async () => ({ id: "cust_eu", key: "app_1:user_1" }),
  });

  assert.deepEqual(listedCustomers, [["cust_eu"]]);
  assert.equal(result.totalCount, 1);
  assert.equal(result.items[0]?.id, "inv_1");
});

test("listAppUserInvoices returns empty when ensure yields blank customer id", async () => {
  const result = await listAppUserInvoices({
    client: { billing: { invoices: { list: async () => ({ items: [] }) } } } as never,
    clientId: "app_1",
    externalUserId: "user_1",
    ensureCustomer: async () => ({ id: "  ", key: "app_1:user_1" }),
  });
  assert.equal(result.totalCount, 0);
  assert.deepEqual(result.items, []);
});

test("getAppUserInvoice scopes by customer id", async () => {
  const client = {
    billing: {
      invoices: {
        list: async () => ({
          items: [
            {
              id: "inv_other",
              status: "issued",
              currency: "USD",
              totals: { total: "1.00" },
              customer: { id: "cust_other", key: "other" },
            },
            {
              id: "inv_mine",
              status: "issued",
              currency: "USD",
              totals: { total: "2.00" },
              customer: { id: "cust_eu", key: "app_1:user_1" },
              externalIds: { invoicing: "in_stripe_1" },
            },
          ],
        }),
      },
    },
  };

  assert.equal(
    await getAppUserInvoice({
      client: client as never,
      clientId: "app_1",
      externalUserId: "user_1",
      invoiceId: "inv_other",
      ensureCustomer: async () => ({ id: "cust_eu", key: "app_1:user_1" }),
    }),
    null,
  );

  const mine = await getAppUserInvoice({
    client: client as never,
    clientId: "app_1",
    externalUserId: "user_1",
    invoiceId: "inv_mine",
    ensureCustomer: async () => ({ id: "cust_eu", key: "app_1:user_1" }),
  });
  assert.equal(mine?.id, "inv_mine");
  assert.equal(mine?.externalInvoicingId, "in_stripe_1");

  assert.equal(
    await getAppUserInvoice({
      client: client as never,
      clientId: "",
      externalUserId: "user_1",
      invoiceId: "inv_mine",
    }),
    null,
  );
});
