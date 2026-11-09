import { vi } from "vitest";
import { getSettings, type AvaTaxSettings } from "../../functions/lib/avatax";

// raw settings as returned by swell.settings()
export const rawSettings = {
  environment: "sandbox",
  account_id: "2000123456",
  license_key: "LICENSEKEY123",
  company_code: "SWELL",
};

export function makeSettings(overrides: Partial<AvaTaxSettings> = {}): AvaTaxSettings {
  return { ...getSettings({ avatax: rawSettings }), ...overrides };
}

export const ORDER_ID = "ord_1";
export const INVOICE_ID = "inv_1";
export const ACCOUNT_ID = "acc_1";

export const address = { address1: "100 Congress Ave", city: "Austin", state: "TX", zip: "78701", country: "US" };

// shipping locations as /settings/shipments/locations returns them
export const locations = [
  { id: "default", name: "Main", address1: "1 Market St", city: "San Francisco", state: "CA", zip: "94105", country: "US" },
  { id: "loc_ny", name: "NY", address1: "5 Broadway", city: "New York", state: "NY", zip: "10004", country: "US" },
];

export function makeProduct(overrides: Record<string, any> = {}) {
  return { id: "prod_1", name: "T-shirt", sku: "TS-1", type: "standard", tax_code: undefined, ...overrides };
}

export function makeAccount(overrides: Record<string, any> = {}) {
  return { id: ACCOUNT_ID, email: "Jane@Example.com", ...overrides };
}

// a cart or order as the tax hook sees it
export function makeCart(overrides: Record<string, any> = {}) {
  return {
    id: "cart_1",
    number: "1042",
    currency: "USD",
    account_id: ACCOUNT_ID,
    shipping: { ...address, service: "fedex_ground", service_name: "FedEx Ground" },
    billing: { ...address },
    shipment_total: 10,
    items: [{ id: "item_1", product_id: "prod_1", quantity: 2, price_total: 50, discount_total: 5 }],
    ...overrides,
  };
}

export function makeOrder(overrides: Record<string, any> = {}) {
  return {
    ...makeCart(),
    id: ORDER_ID,
    paid: true,
    date_created: "2026-10-09T10:00:00.000Z",
    items: [{ id: "item_1", product_id: "prod_1", product: makeProduct(), quantity: 2, price_total: 50, discount_total: 5 }],
    account: makeAccount(),
    ...overrides,
  };
}

// an AvaTax transaction with the tax of each line, in line order
export function makeTransaction(taxes: number[] = [3.6, 0.8], overrides: Record<string, any> = {}) {
  return {
    code: "1042",
    totalTax: taxes.reduce((a, b) => a + b, 0),
    summary: [{ taxType: "Sales", taxName: "TX STATE TAX" }],
    lines: taxes.map((tax, i) => ({ lineNumber: String(i + 1), tax, taxCalculated: tax })),
    ...overrides,
  };
}

type Reply = { status: number; body?: any } | Error;

export const ok = (body: any, status = 200): Reply => ({ status, body });
export const fail = (status: number, code: string, message: string, description?: string): Reply => ({
  status,
  body: { error: { code, message, details: description ? [{ code, description, severity: "Error" }] : [] } },
});

function respond(reply: Reply): Response {
  if (reply instanceof Error) throw reply;
  return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
}

export interface Routes {
  transaction?: Reply;
  void?: Reply;
  ping?: Reply;
  companies?: Reply;
}

// Mocks global fetch by AvaTax endpoint
export function mockAvaTax(routes: Routes = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v2", "");
    if (path === "/transactions/createoradjust") return respond(routes.transaction ?? ok(makeTransaction()));
    if (path.endsWith("/void")) return respond(routes.void ?? ok({ status: "Cancelled" }));
    if (path === "/utilities/ping") return respond(routes.ping ?? ok({ authenticated: true, version: "26.10" }));
    if (path === "/companies") return respond(routes.companies ?? ok({ value: [{ id: 1, companyCode: "SWELL", name: "Swell Inc", isActive: true }] }));
    throw new Error(`unexpected fetch ${init?.method || "GET"} ${url}`);
  });
}

// method, url, headers and parsed body of a fetch call
export function callOf(call: any[]) {
  const [url, init] = call;
  return {
    method: init?.method || "GET",
    url: String(url),
    headers: init?.headers || {},
    body: init?.body ? JSON.parse(init.body) : undefined,
  };
}

// the CreateTransactionModel of each createoradjust call
export function sentTransactions(fetchMock: { mock: { calls: any[][] } }) {
  return fetchMock.mock.calls
    .map(callOf)
    .filter((call) => call.url.includes("/transactions/createoradjust"))
    .map((call) => call.body.createTransactionModel);
}

// Settings → Taxes with AvaTax selected as the tax service
export const taxSettings = { location_source: "shipping", extension_app_id: "6ae86ec397c0040013ebfcf4", extension_config_id: "avatax" };

// Swell client mock: answers get by path
export function makeSwell(records: Record<string, any> = {}, settings: any = rawSettings) {
  return {
    get: vi.fn(async (path: string, query?: any) => {
      if (path === "/settings/shipments/locations") return "locations" in records ? records.locations : locations;
      if (path === "/settings/taxes") return "taxes" in records ? records.taxes : taxSettings;
      if (path === "/settings/integrations") return "integrations" in records ? records.integrations : null;
      if (path === "/products") {
        const ids: string[] = query?.where?.id?.$in || [];
        const products = "products" in records ? records.products : [makeProduct()];
        return { results: products.filter((p: any) => ids.includes(p.id)) };
      }
      if (path === `/accounts/${ACCOUNT_ID}`) return "account" in records ? records.account : makeAccount();
      if (path === `/orders/${ORDER_ID}`) return "order" in records ? records.order : makeOrder();
      if (path === `/invoices/${INVOICE_ID}`) return "invoice" in records ? records.invoice : null;
      return null;
    }),
    settings: vi.fn().mockResolvedValue({ avatax: settings }),
  };
}
