import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildLines,
  customerCode,
  documentDate,
  exemption,
  hasCustomerAddress,
  hasTaxAddress,
  productTaxCode,
  shippingItemCode,
  shippingTaxCode,
  transactionCode,
  transactionModel,
  voidTransaction,
  withProducts,
  type TaxContext,
} from "../../functions/lib/transactions";
import { address, fail, locations, makeAccount, makeCart, makeProduct, makeSettings, mockAvaTax } from "../helpers/avatax-fixtures";

afterEach(() => vi.restoreAllMocks());

const settings = makeSettings();

function context(overrides: Partial<TaxContext> = {}): TaxContext {
  return { locations: new Map(locations.map((l) => [l.id, l])), locationSource: "shipping", account: makeAccount(), ...overrides };
}

const ava = (a: any) => ({ line1: a.address1, city: a.city, region: a.state, country: a.country, postalCode: a.zip });

describe("addresses", () => {
  it("needs a zip, or a street, city and state", () => {
    expect(hasCustomerAddress({ shipping: { zip: "78701" } })).toBe(true);
    expect(hasCustomerAddress({ billing: { address1: "1 A", city: "B", state: "TX" } })).toBe(true);
    expect(hasCustomerAddress({ shipping: { city: "Austin", country: "US" } })).toBe(false);
    expect(hasCustomerAddress({})).toBe(false);
  });

  it("falls back to the default location for recording", () => {
    expect(hasTaxAddress({}, context())).toBe(true);
    expect(hasTaxAddress({}, context({ locations: new Map() }))).toBe(false);
  });
});

describe("buildLines", () => {
  const items = [{ id: "item_1", product: makeProduct(), quantity: 2, price_total: 50, discount_total: 5 }];

  it("builds item and shipping lines shipped from the default location", () => {
    const built = buildLines(makeCart(), items, context(), settings);
    expect(built.itemLines).toEqual(["1"]);
    expect(built.shippingLine).toBe("2");
    expect(built.lines[0]).toEqual({
      number: "1",
      quantity: 2,
      amount: 45,
      itemCode: "TS-1",
      description: "T-shirt",
      taxCode: "P0000000",
      addresses: { shipFrom: ava(locations[0]), shipTo: ava(address) },
    });
    expect(built.lines[1]).toMatchObject({
      number: "2",
      quantity: 1,
      amount: 10,
      itemCode: "FEDEX-GROUND-SHIPPING",
      description: "FedEx Ground",
      taxCode: "FR030000",
    });
  });

  it("ships an item from its own location", () => {
    const built = buildLines(makeCart(), [{ ...items[0], shipment_location: "loc_ny" }], context(), settings);
    expect(built.lines[0].addresses).toEqual({ shipFrom: ava(locations[1]), shipTo: ava(address) });
  });

  it("uses the billing address when Settings → Taxes says so", () => {
    const billing = { zip: "10001", country: "US" };
    const built = buildLines(makeCart({ billing }), items, context({ locationSource: "billing" }), settings);
    expect(built.lines[0].addresses).toMatchObject({ shipTo: { postalCode: "10001" } });
  });

  it("uses one location when there is no ship-from address or the customer has none", () => {
    expect(buildLines(makeCart(), items, context({ locations: new Map() }), settings).lines[0].addresses).toEqual({
      singleLocation: ava(address),
    });
    const noAddress = buildLines(makeCart({ shipping: {}, billing: {} }), items, context(), settings);
    expect(noAddress.lines[0].addresses).toEqual({ singleLocation: ava(locations[0]) });
  });

  it("uses one location when the ship-from address is incomplete", () => {
    const partial = new Map([["default", { id: "default", city: "Austin" }]]);
    expect(buildLines(makeCart(), items, context({ locations: partial }), settings).lines[0].addresses).toEqual({
      singleLocation: ava(address),
    });
  });

  it("adds return lines, a restocking fee and tax-included flags", () => {
    const record = makeCart({ item_tax_included: true, shipment_tax_included: true, return_credit_total: 3 });
    const built = buildLines(
      record,
      [{ ...items[0], quantity_returned: 1, return_price_total: 25, return_discount_total: 2.5 }],
      context(),
      settings,
    );
    expect(built.lines.map((l) => [l.number, l.quantity, l.amount, l.taxCode, l.taxIncluded])).toEqual([
      ["1", 2, 45, "P0000000", true],
      ["2", 1, -22.5, "P0000000", true],
      ["3", 1, 10, "FR030000", true],
      ["4", 1, -3, "OR040000", true],
    ]);
    expect(built.itemLines).toEqual(["1"]);
    expect(built.shippingLine).toBe("3");
  });

  it("uses quantity_total and leaves out shipping without a service", () => {
    const built = buildLines(makeCart({ shipping: address }), [{ ...items[0], quantity_total: 4 }], context(), settings);
    expect(built.lines).toHaveLength(1);
    expect(built.lines[0].quantity).toBe(4);
    expect(built.shippingLine).toBeUndefined();
  });

  it("treats subscription tax_included as item prices with tax", () => {
    expect(buildLines(makeCart({ tax_included: true }), items, context(), settings).lines[0].taxIncluded).toBe(true);
  });
});

describe("tax codes", () => {
  it("picks the product, gift card or default tax code", () => {
    expect(productTaxCode(makeProduct({ tax_code: "PC040100" }), settings)).toBe("PC040100");
    expect(productTaxCode(makeProduct({ type: "giftcard", delivery: "shipment" }), settings)).toBe("PG050000");
    expect(productTaxCode(makeProduct({ type: "giftcard", delivery: "giftcard" }), settings)).toBe("DG020000");
    expect(productTaxCode(undefined, makeSettings({ product_tax_code: "P0000001" }))).toBe("P0000001");
  });

  it("takes the shipping service's tax code from the rates", () => {
    const record = makeCart({ shipment_rating: { services: [{ id: "fedex_ground", tax_code: "FR020100" }] } });
    expect(shippingTaxCode(record, settings)).toBe("FR020100");
    expect(shippingTaxCode(makeCart(), settings)).toBe("FR030000");
  });

  it("keeps -SHIPPING at the end of long item codes", () => {
    const code = shippingItemCode("x".repeat(60));
    expect(code).toHaveLength(50);
    expect(code.endsWith("-SHIPPING")).toBe(true);
    expect(shippingItemCode("ups-SHIPPING")).toBe("UPS-SHIPPING");
  });
});

describe("customer", () => {
  it("uses the lowercased email, then the account id, then guest", () => {
    expect(customerCode(makeAccount(), {})).toBe("jane@example.com");
    expect(customerCode(null, { account_id: "acc_9" })).toBe("acc_9");
    expect(customerCode(null, {})).toBe("guest");
  });

  it("sends the exemption fields set on the customer", () => {
    expect(exemption(makeAccount({ $app: { avatax: { entity_use_code: "G", exemption_number: " EX-1 " } } }))).toEqual({
      entityUseCode: "G",
      exemptionNo: "EX-1",
    });
    expect(exemption(makeAccount({ $app: { avatax: { entity_use_code: "" } } }))).toEqual({});
    expect(exemption(null)).toEqual({});
  });
});

describe("transaction", () => {
  it("prefixes codes by record type", () => {
    expect(transactionCode(1042, "orders")).toBe("1042");
    expect(transactionCode("7", "invoices")).toBe("I-7");
    expect(transactionCode("7", "subscriptions")).toBe("S-7");
    expect(transactionCode("7", "carts")).toBe("C-7");
    expect(transactionCode(undefined, "orders")).toBeUndefined();
  });

  it("formats dates as YYYY-MM-DD", () => {
    expect(documentDate("2026-10-09T23:30:00.000Z")).toBe("2026-10-09");
    expect(documentDate("not a date")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("builds a calculation and a recorded sale", () => {
    const ctx = context({ account: makeAccount({ $app: { avatax: { entity_use_code: "E" } } }) });
    expect(transactionModel(makeCart(), [], ctx, settings, { code: undefined, date: "2026-11-02", record: false })).toEqual({
      type: "SalesOrder",
      commit: false,
      companyCode: "SWELL",
      date: "2026-11-02",
      customerCode: "jane@example.com",
      entityUseCode: "E",
      currencyCode: "USD",
      lines: [],
    });
    expect(transactionModel(makeCart(), [], ctx, settings, { code: "1042", date: "2026-10-09", record: true })).toMatchObject({
      code: "1042",
      type: "SalesInvoice",
      commit: true,
      purchaseOrderNo: "1042",
    });
  });
});

describe("voidTransaction", () => {
  it("voids the sales invoice with the record's code", async () => {
    const fetchMock = mockAvaTax();
    expect(await voidTransaction(settings, "1042")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(String(url)).toBe("https://sandbox-rest.avatax.com/api/v2/companies/SWELL/transactions/1042/void?documentType=SalesInvoice");
    expect(JSON.parse(init.body)).toEqual({ code: "DocVoided" });
  });

  it("returns false when AvaTax has no such document or it's already voided", async () => {
    mockAvaTax({ void: fail(404, "EntityNotFoundError", "not found") });
    expect(await voidTransaction(settings, "1042")).toBe(false);
    vi.restoreAllMocks();
    mockAvaTax({ void: fail(400, "TransactionAlreadyCancelled", "already") });
    expect(await voidTransaction(settings, "1042")).toBe(false);
  });

  it("throws other errors, including a plain 404", async () => {
    mockAvaTax({ void: { status: 404, body: undefined } });
    await expect(voidTransaction(settings, "1042")).rejects.toMatchObject({ status: 404 });
  });
});

describe("withProducts", () => {
  it("loads missing products in one call", async () => {
    const swell = { get: vi.fn().mockResolvedValue({ results: [makeProduct()] }), settings: vi.fn() };
    const items = await withProducts(swell, [{ id: "i1", product_id: "prod_1" }, { id: "i2", product_id: "prod_1" }, { id: "i3", product: makeProduct({ id: "p2" }) }]);
    expect(swell.get).toHaveBeenCalledTimes(1);
    expect(swell.get.mock.calls[0][1]).toMatchObject({ where: { id: { $in: ["prod_1"] } } });
    expect(items.map((i) => i.product?.id)).toEqual(["prod_1", "prod_1", "p2"]);
  });

  it("makes no call when every item has its product", async () => {
    const swell = { get: vi.fn(), settings: vi.fn() };
    await withProducts(swell, [{ product: makeProduct() }]);
    expect(swell.get).not.toHaveBeenCalled();
  });
});
