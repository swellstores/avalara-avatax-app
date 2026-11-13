import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockRequest } from "../helpers/mock-request";
import {
  ACCOUNT_ID,
  INVOICE_ID,
  ORDER_ID,
  address,
  callOf,
  fail,
  makeAccount,
  makeCart,
  makeOrder,
  makeSwell,
  makeTransaction,
  mockAvaTax,
  ok,
  rawSettings,
  sentTransactions,
} from "../helpers/avatax-fixtures";
import calculateTaxes, { config as calculateConfig } from "../../functions/calculate-taxes";
import recordOrder, { config as recordConfig, isSaleChange } from "../../functions/record-order";
import testConnection, { config as testConfig } from "../../functions/test-connection";
import { HOOK_DEADLINE_MS } from "../../functions/lib/avatax";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

function request(data: Record<string, any>, records: Record<string, any> = {}, settings: any = rawSettings) {
  const swell = makeSwell(records, settings);
  const req = createMockRequest({ data, swell: swell as any, appId: "avatax" });
  return { req, swell };
}

const unset = { ...rawSettings, license_key: "" };

describe("calculate-taxes", () => {
  // like Swell: the change being saved, with the saved record in $record
  const hook = (data: Record<string, any> = makeCart(), $record: Record<string, any> = {}) => ({
    ...data,
    $record,
    $event: { type: "order.taxes", hook: "before", model: "orders" },
  });

  it("is the tax extension's before:order.taxes hook", () => {
    expect(calculateConfig).toMatchObject({
      extension: "avatax",
      model: { events: ["before:order.taxes"], fields: ["items", "taxes", "shipment_tax", "product_taxes"] },
    });
  });

  it("returns AvaTax's item, shipping and total tax", async () => {
    const fetchMock = mockAvaTax();
    const { req } = request(hook());
    expect(await calculateTaxes(req)).toEqual({
      items: [{ id: "item_1", taxes: [{ id: "avatax", amount: 3.6 }] }],
      shipment_tax: 0.8,
      taxes: [{ id: "avatax", name: "Sales tax", amount: 4.4, shipping: true }],
    });
    const [model] = sentTransactions(fetchMock);
    expect(model).toMatchObject({
      type: "SalesOrder",
      commit: false,
      companyCode: "SWELL",
      customerCode: "jane@example.com",
      currencyCode: "USD",
    });
    expect(model.code).toBeUndefined();
    expect(model.lines.map((l: any) => [l.number, l.amount, l.itemCode])).toEqual([
      ["1", 45, "TS-1"],
      ["2", 10, "FEDEX-GROUND-SHIPPING"],
    ]);
  });

  it("merges the change with the saved record", async () => {
    const fetchMock = mockAvaTax({ transaction: ok(makeTransaction([3.6])) });
    const saved = makeCart();
    const { req } = request(hook({ shipping: { zip: "10001", country: "US" } }, saved));
    const result: any = await calculateTaxes(req);
    expect(result.items).toEqual([{ id: "item_1", taxes: [{ id: "avatax", amount: 3.6 }] }]);
    const [model] = sentTransactions(fetchMock);
    expect(model.lines).toHaveLength(1);
    expect(model.lines[0].addresses.shipTo).toMatchObject({ postalCode: "10001" });
  });

  it("sends the customer's exemption", async () => {
    const fetchMock = mockAvaTax();
    const account = makeAccount({ $app: { avatax: { entity_use_code: "G", exemption_number: "R-1" } } });
    const { req } = request(hook(), { account });
    await calculateTaxes(req);
    expect(sentTransactions(fetchMock)[0]).toMatchObject({ entityUseCode: "G", exemptionNo: "R-1" });
  });

  it("calculates a guest cart without loading an account", async () => {
    const fetchMock = mockAvaTax();
    const { req, swell } = request(hook(makeCart({ account_id: undefined })));
    await calculateTaxes(req);
    expect(sentTransactions(fetchMock)[0].customerCode).toBe("guest");
    expect(swell.get.mock.calls.map(([p]) => p)).not.toContain(`/accounts/${ACCOUNT_ID}`);
  });

  it("puts a subscription's plan tax in product_taxes", async () => {
    const fetchMock = mockAvaTax({ transaction: ok(makeTransaction([1, 0.5, 2])) });
    const subscription = makeCart({ product_id: "prod_1", price_total: 20, product_discount_total: 2, quantity: 1 });
    const { req } = request(hook(subscription));
    const result: any = await calculateTaxes(req);
    expect(result.items).toEqual([{ id: "item_1", taxes: [{ id: "avatax", amount: 1 }] }]);
    expect(result.product_taxes).toEqual([{ id: "avatax", amount: 0.5 }]);
    expect(result.shipment_tax).toBe(2);
    expect(result.taxes[0].amount).toBe(3.5);
    expect(sentTransactions(fetchMock)[0].lines.map((l: any) => l.amount)).toEqual([45, 18, 10]);
  });

  it("skips a subscription's plan during a trial", async () => {
    const fetchMock = mockAvaTax();
    const { req } = request(hook(makeCart({ product_id: "prod_1", price_total: 20, trial: true })));
    const result: any = await calculateTaxes(req);
    expect(result.product_taxes).toBeUndefined();
    expect(sentTransactions(fetchMock)[0].lines).toHaveLength(2);
  });

  it.each([
    ["the app is not set up", hook(), unset],
    ["credentials are missing", hook(), { ...rawSettings, account_id: "" }],
    ["taxes are fixed", hook(makeCart({ taxes_fixed: true })), rawSettings],
    ["the customer has no address", hook(makeCart({ shipping: { country: "US" }, billing: {} })), rawSettings],
    ["there is nothing to tax", hook(makeCart({ items: [], shipping: address })), rawSettings],
  ])("calculates nothing when %s", async (_name, data, settings) => {
    const fetchMock = mockAvaTax();
    const { req, swell } = request(data, {}, settings);
    expect(await calculateTaxes(req)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(swell.get).not.toHaveBeenCalled();
  });

  it("continues without tax when AvaTax fails and rejecting is turned off", async () => {
    mockAvaTax({ transaction: fail(400, "InvalidAddress", "bad", "The zip code is not valid.") });
    const { req } = request(hook(), {}, { ...rawSettings, block_on_failure: false });
    expect(await calculateTaxes(req)).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("The zip code is not valid."));
  });

  it("rejects the change when AvaTax fails (the default)", async () => {
    mockAvaTax({ transaction: fail(400, "InvalidAddress", "bad", "The zip code is not valid.") });
    const { req } = request(hook());
    await expect(calculateTaxes(req)).rejects.toMatchObject({
      name: "SwellRejection",
      status: 422,
      body: { $reject: { code: "avatax_failed", message: expect.stringContaining("The zip code is not valid.") } },
    });
  });

  it("rejects when AvaTax doesn't answer in time", async () => {
    mockAvaTax({ transaction: new DOMException("The operation was aborted due to timeout", "TimeoutError") });
    const { req } = request(hook());
    await expect(calculateTaxes(req)).rejects.toMatchObject({
      body: {
        $reject: {
          code: "avatax_failed",
          message: "Taxes could not be calculated. AvaTax didn't answer in time. Try again in a few minutes.",
        },
      },
    });
  });

  it("rejects when loading the record from Swell runs past the hook's deadline, without calling AvaTax", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = mockAvaTax();
      const { req, swell } = request(hook());
      const load = swell.get.getMockImplementation()!;
      swell.get.mockImplementation((path: string, query?: any) =>
        path === "/products" ? new Promise(() => {}) : load(path, query));
      const result = calculateTaxes(req).catch((err) => err);
      await vi.advanceTimersByTimeAsync(HOOK_DEADLINE_MS);
      expect(await result).toMatchObject({
        body: { $reject: { message: "Taxes could not be calculated. Calculating took too long. Try again in a few minutes." } },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("deadline passed loading the record from Swell"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives AvaTax only the time left before the hook's deadline", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    mockAvaTax();
    const { req, swell } = request(hook());
    const load = swell.get.getMockImplementation()!;
    // Swell takes 3 s to load the products
    swell.get.mockImplementation(async (path: string, query?: any) => {
      if (path === "/products") vi.setSystemTime(Date.now() + 3000);
      return load(path, query);
    });
    await calculateTaxes(req);
    const [ms] = timeout.mock.calls.at(-1)!;
    expect(ms).toBeLessThanOrEqual(HOOK_DEADLINE_MS - 3000);
    expect(ms).toBeGreaterThan(HOOK_DEADLINE_MS - 3000 - 1000);
    vi.useRealTimers();
  });

  it("rejects when reading the app settings runs past the hook's deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = mockAvaTax();
      const { req, swell } = request(hook());
      swell.settings.mockReturnValue(new Promise(() => {}));
      const result = calculateTaxes(req).catch((err) => err);
      await vi.advanceTimersByTimeAsync(HOOK_DEADLINE_MS);
      expect(await result).toMatchObject({
        body: { $reject: { message: "Taxes could not be calculated. Calculating took too long. Try again in a few minutes." } },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("deadline passed loading the app settings"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects when the app settings can't be read, as Reject is on by default", async () => {
    mockAvaTax();
    const { req, swell } = request(hook());
    swell.settings.mockRejectedValue(new Error("settings unavailable"));
    await expect(calculateTaxes(req)).rejects.toMatchObject({
      body: { $reject: { code: "avatax_failed", message: expect.stringContaining("settings unavailable") } },
    });
  });

  it("reports an AvaTax timeout shortened by slow Swell reads as the hook's deadline", async () => {
    mockAvaTax({ transaction: new DOMException("The operation was aborted due to timeout", "TimeoutError") });
    const { req, swell } = request(hook());
    const load = swell.get.getMockImplementation()!;
    // Swell takes 3 s to load the products, so AvaTax gets less than its full timeout
    swell.get.mockImplementation(async (path: string, query?: any) => {
      if (path === "/products") vi.setSystemTime(Date.now() + 3000);
      return load(path, query);
    });
    try {
      await expect(calculateTaxes(req)).rejects.toMatchObject({
        body: { $reject: { message: "Taxes could not be calculated. Calculating took too long. Try again in a few minutes." } },
      });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("deadline passed waiting for AvaTax"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects when AvaTax can't be reached and the setting asks for it", async () => {
    mockAvaTax({ transaction: new TypeError("fetch failed") });
    const { req } = request(hook(), {}, { ...rawSettings, block_on_failure: true });
    await expect(calculateTaxes(req)).rejects.toMatchObject({
      body: { $reject: { message: "Taxes could not be calculated. AvaTax could not be reached. Try again in a few minutes." } },
    });
  });
});

describe("record-order", () => {
  // like Swell: the whole record, with the changed fields in $event.data
  const event = (type: string, changed: Record<string, any> = { paid: true }, id = ORDER_ID) => ({
    ...makeOrder(),
    id,
    $event: { type, model: type.startsWith("invoice") ? "invoices" : "orders", data: { id, ...changed } },
  });

  it("listens to order and invoice changes", () => {
    expect(recordConfig.model?.events).toEqual([
      "order.created",
      "order.updated",
      "order.paid",
      "order.canceled",
      "order.refunded",
      "invoice.created",
      "invoice.updated",
      "invoice.payment_succeeded",
      "invoice.refunded",
    ]);
  });

  it("records nothing while another tax service is selected", async () => {
    const fetchMock = mockAvaTax();
    const { req, swell } = request(event("order.paid"), { taxes: { location_source: "shipping" } });
    expect(await recordOrder(req)).toEqual({ outcome: "not the tax service" });
    expect(swell.get).not.toHaveBeenCalledWith(`/orders/${ORDER_ID}`, expect.anything());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records a paid order as a committed sales invoice", async () => {
    const fetchMock = mockAvaTax();
    const { req, swell } = request(event("order.updated"));
    expect(await recordOrder(req)).toEqual({ outcome: "recorded" });
    expect(swell.get).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, { expand: ["items.product", "account"] });
    // the tax service check and the ship-to setting share one read of Settings → Taxes
    expect(swell.get.mock.calls.filter(([path]: any[]) => path === "/settings/taxes")).toHaveLength(1);
    const [model] = sentTransactions(fetchMock);
    expect(model).toMatchObject({
      code: "1042",
      type: "SalesInvoice",
      commit: true,
      date: "2026-10-09",
      customerCode: "jane@example.com",
      purchaseOrderNo: "1042",
    });
    expect(model.lines.map((l: any) => [l.number, l.amount])).toEqual([
      ["1", 45],
      ["2", 10],
    ]);
  });

  it("records an order when it's paid (order.paid carries only id and payment_id)", async () => {
    mockAvaTax();
    const { req } = request(event("order.paid", { payment_id: "pay_1" }));
    expect(await recordOrder(req)).toEqual({ outcome: "recorded" });
  });

  it("records an order created paid", async () => {
    mockAvaTax();
    const { req } = request(event("order.created", {}));
    expect(await recordOrder(req)).toEqual({ outcome: "recorded" });
  });

  it("ignores updates that don't change the sale", async () => {
    const fetchMock = mockAvaTax();
    const { req, swell } = request(event("order.updated", { notes: "hi", $app: { other: {} } }));
    expect(await recordOrder(req)).toBeUndefined();
    expect(swell.settings).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isSaleChange({ type: "order.updated", data: { items: [] } })).toBe(true);
  });

  it.each([
    ["the app is not set up", unset],
    ["recording is off", { ...rawSettings, record_sales: false }],
    ["credentials are missing", { ...rawSettings, license_key: "" }],
  ])("does nothing when %s", async (_name, settings) => {
    const fetchMock = mockAvaTax();
    const { req, swell } = request(event("order.updated"), {}, settings);
    expect(await recordOrder(req)).toBeUndefined();
    expect(swell.get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["not paid", { order: makeOrder({ paid: false }) }],
    ["taxes fixed", { order: makeOrder({ taxes_fixed: true }) }],
    ["not found", { order: null }],
    ["no address", { order: makeOrder({ shipping: {}, billing: {} }), locations: [] }],
  ])("skips an order that is %s", async (outcome, records) => {
    const fetchMock = mockAvaTax();
    const { req } = request(event("order.updated"), records);
    expect(await recordOrder(req)).toEqual({ outcome });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("voids a canceled order", async () => {
    const fetchMock = mockAvaTax();
    const { req } = request(event("order.updated", { canceled: true }), { order: makeOrder({ canceled: true }) });
    expect(await recordOrder(req)).toEqual({ outcome: "voided" });
    expect(callOf(fetchMock.mock.calls[0]).url).toContain("/companies/SWELL/transactions/1042/void");
    expect(sentTransactions(fetchMock)).toHaveLength(0);
  });

  it("reports a canceled order AvaTax never recorded", async () => {
    mockAvaTax({ void: fail(404, "EntityNotFoundError", "not found") });
    const { req } = request(event("order.updated", { canceled: true }), { order: makeOrder({ canceled: true, paid: false }) });
    expect(await recordOrder(req)).toEqual({ outcome: "not recorded" });
  });

  it("records an invoice with the subscription's addresses", async () => {
    const fetchMock = mockAvaTax();
    const invoice = {
      id: INVOICE_ID,
      number: "77",
      paid: true,
      currency: "USD",
      account_id: ACCOUNT_ID,
      date_created: "2026-10-20T00:00:00.000Z",
      items: [{ id: "item_9", product_id: "prod_1", quantity: 1, price_total: 20 }],
      subscription: { shipping: address, billing: address },
    };
    const { req, swell } = request(event("invoice.updated", { paid: true }, INVOICE_ID), { invoice });
    expect(await recordOrder(req)).toEqual({ outcome: "recorded" });
    expect(swell.get).toHaveBeenCalledWith(`/invoices/${INVOICE_ID}`, { expand: ["items.product", "account", "subscription"] });
    const [model] = sentTransactions(fetchMock);
    expect(model.code).toBe("I-77");
    expect(model.lines[0].addresses.shipTo).toMatchObject({ postalCode: "78701" });
  });

  it("doesn't record an invoice for an order, since the order is recorded", async () => {
    const fetchMock = mockAvaTax();
    const invoice = { id: INVOICE_ID, number: "78", paid: true, order_id: "order_1", items: [] };
    const { req } = request(event("invoice.updated", { paid: true }, INVOICE_ID), { invoice });
    expect(await recordOrder(req)).toEqual({ outcome: "order invoice" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("voids a voided invoice", async () => {
    const fetchMock = mockAvaTax();
    const invoice = { id: INVOICE_ID, number: "77", paid: true, void: true };
    const { req } = request(event("invoice.updated", { void: true }, INVOICE_ID), { invoice });
    expect(await recordOrder(req)).toEqual({ outcome: "voided" });
    expect(callOf(fetchMock.mock.calls[0]).url).toContain("/transactions/I-77/void");
  });

  it("throws temporary AvaTax errors so the event is retried", async () => {
    mockAvaTax({ transaction: fail(503, "ServiceUnavailable", "down") });
    const { req } = request(event("order.updated"));
    await expect(recordOrder(req)).rejects.toMatchObject({ name: "AvaTaxError", status: 503 });
  });

  it("logs permanent AvaTax errors", async () => {
    mockAvaTax({ transaction: fail(400, "CannotModifyLockedTransaction", "locked", "The transaction is locked.") });
    const { req } = request(event("order.updated"));
    expect(await recordOrder(req)).toEqual({ outcome: "failed" });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("orders 1042 not recorded"));
  });
});

describe("test-connection", () => {
  async function expectFailure(promise: Promise<unknown>, message: string | RegExp) {
    const err: any = await promise.catch((e) => e);
    expect(err).toMatchObject({ name: "SwellError", status: 400 });
    expect(err.message).toMatch(message);
  }

  it("is an action", () => {
    expect(testConfig).toMatchObject({ action: true });
  });

  it("confirms the connection and the company", async () => {
    const fetchMock = mockAvaTax();
    const { req } = request({});
    expect(await testConnection(req)).toEqual({ message: "Connected to AvaTax (Sandbox), company Swell Inc." });
    const companies = callOf(fetchMock.mock.calls[1]);
    expect(decodeURIComponent(companies.url)).toContain("$filter=companyCode eq 'SWELL'");
  });

  it("doesn't add a second period after a company name that ends with one", async () => {
    mockAvaTax({ companies: ok({ value: [{ companyCode: "SWELL", name: "Swell Inc.", isActive: true }] }) });
    const { req } = request({});
    expect(await testConnection(req)).toEqual({ message: "Connected to AvaTax (Sandbox), company Swell Inc." });
  });

  it("says when recording sales is off", async () => {
    mockAvaTax();
    const { req } = request({}, {}, { ...rawSettings, record_sales: false });
    const { message } = (await testConnection(req)) as any;
    expect(message).toContain("Recording sales is off");
  });

  it("warns when Swell's built-in AvaTax integration is also connected", async () => {
    mockAvaTax();
    const { req } = request({}, { integrations: { services: { avatax: { type: "tax", enabled: true } } } });
    const { message } = (await testConnection(req)) as any;
    expect(message).toContain("built-in Avalara AvaTax integration is also connected");
  });

  it("treats any truthy enabled as connected, as Swell does", async () => {
    mockAvaTax();
    const { req } = request({}, { integrations: { services: { avatax: { enabled: "true" } } } });
    const { message } = (await testConnection(req)) as any;
    expect(message).toContain("Disconnect it in Integrations,");
  });

  it("leaves out the warning and logs it when the integrations can't be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockAvaTax();
    const { req, swell } = request({});
    swell.get.mockRejectedValueOnce(new Error("Swell is down"));
    const { message } = (await testConnection(req)) as any;
    expect(message).toBe("Connected to AvaTax (Sandbox), company Swell Inc.");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Swell is down"));
  });

  it("doesn't warn when the built-in AvaTax integration is set up but not enabled", async () => {
    mockAvaTax();
    const { req } = request({}, { integrations: { services: { avatax: { type: "tax", enabled: false, activated: true } } } });
    const { message } = (await testConnection(req)) as any;
    expect(message).toBe("Connected to AvaTax (Sandbox), company Swell Inc.");
  });

  it("asks for missing credentials without calling AvaTax", async () => {
    const fetchMock = mockAvaTax();
    const { req } = request({}, {}, { environment: "sandbox" });
    await expectFailure(testConnection(req), "Add the account ID, license key, company code and save the settings first.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports wrong credentials", async () => {
    mockAvaTax({ ping: ok({ authenticated: false }) });
    await expectFailure(testConnection(request({}).req), /didn't accept the account ID or license key/);
  });

  it("reports an unknown or inactive company", async () => {
    mockAvaTax({ companies: ok({ value: [] }) });
    await expectFailure(testConnection(request({}).req), /no company with the code SWELL/);
    vi.restoreAllMocks();
    mockAvaTax({ companies: ok({ value: [{ companyCode: "SWELL", isActive: false }] }) });
    await expectFailure(testConnection(request({}).req), /SWELL is not active/);
  });

  it("explains connection errors", async () => {
    mockAvaTax({ ping: new TypeError("fetch failed") });
    await expectFailure(testConnection(request({}).req), "AvaTax could not be reached. Try again in a few minutes.");
  });
});
