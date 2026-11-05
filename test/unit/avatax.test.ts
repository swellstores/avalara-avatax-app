import { describe, it, expect, vi, afterEach } from "vitest";
import {
  AvaTaxError,
  CLIENT_HEADER,
  avataxRequest,
  connectionError,
  getSettings,
  loadSettings,
  missingSettings,
} from "../../functions/lib/avatax";
import { callOf, fail, makeSettings, ok, rawSettings } from "../helpers/avatax-fixtures";

afterEach(() => vi.restoreAllMocks());

function mockFetch(reply: { status: number; body?: any } | Error) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
}

describe("getSettings", () => {
  it("applies the same defaults as the settings file", () => {
    expect(getSettings({})).toEqual({
      environment: "sandbox",
      account_id: "",
      license_key: "",
      company_code: "",
      block_on_failure: false,
      product_tax_code: "P0000000",
      shipping_tax_code: "FR030000",
      record_sales: true,
    });
  });

  it("trims values, uppercases tax codes and keeps saved flags", () => {
    const settings = getSettings({
      avatax: {
        environment: "production",
        account_id: " 1 ",
        license_key: " k ",
        company_code: " C ",
        block_on_failure: true,
        product_tax_code: " pc040100 ",
        shipping_tax_code: "fr020100",
        record_sales: false,
      },
    });
    expect(settings).toMatchObject({
      environment: "production",
      account_id: "1",
      license_key: "k",
      company_code: "C",
      block_on_failure: true,
      product_tax_code: "PC040100",
      shipping_tax_code: "FR020100",
      record_sales: false,
    });
  });

  it("treats an unknown environment as sandbox", () => {
    expect(getSettings({ avatax: { environment: "live" } }).environment).toBe("sandbox");
  });
});

describe("missingSettings / loadSettings", () => {
  it("lists every missing credential", () => {
    expect(missingSettings(getSettings({}))).toEqual(["account ID", "license key", "company code"]);
    expect(missingSettings(makeSettings())).toEqual([]);
  });

  it("returns null when not set up", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadSettings({ settings: async () => ({ avatax: { ...rawSettings, license_key: "" } }) })).toBeNull();
    expect(await loadSettings({ settings: async () => ({ avatax: rawSettings }) })).toMatchObject({ company_code: "SWELL" });
  });
});

describe("avataxRequest", () => {
  it("calls the sandbox host with basic auth and the client header", async () => {
    const fetchMock = mockFetch(ok({ authenticated: true }));
    await avataxRequest(makeSettings(), "GET", "/utilities/ping");
    const call = callOf(fetchMock.mock.calls[0]);
    expect(call.url).toBe("https://sandbox-rest.avatax.com/api/v2/utilities/ping");
    expect(call.headers.authorization).toBe(`Basic ${btoa("2000123456:LICENSEKEY123")}`);
    expect(call.headers["x-avalara-client"]).toBe(CLIENT_HEADER);
  });

  it("uses the production host and sends JSON bodies", async () => {
    const fetchMock = mockFetch(ok({}));
    await avataxRequest(makeSettings({ environment: "production" }), "POST", "/transactions/createoradjust", { a: 1 });
    const call = callOf(fetchMock.mock.calls[0]);
    expect(call.url).toBe("https://rest.avatax.com/api/v2/transactions/createoradjust");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toEqual({ a: 1 });
  });

  it("throws AvaTaxError with the code, the detail description and the endpoint", async () => {
    mockFetch(fail(400, "InvalidAddress", "The address is not deliverable.", "The address could not be found."));
    const err = await avataxRequest(makeSettings(), "POST", "/transactions/createoradjust?$include=Lines", {}).catch((e) => e);
    expect(err).toBeInstanceOf(AvaTaxError);
    expect(err).toMatchObject({ status: 400, code: "InvalidAddress", endpoint: "POST /transactions/createoradjust" });
    expect(err.message).toContain("The address could not be found.");
    expect(err.detail).toContain("(POST /transactions/createoradjust)");
    expect(err.retryable).toBe(false);
  });

  it("reports network failures as status 0, retryable", async () => {
    mockFetch(new TypeError("fetch failed"));
    const err = await avataxRequest(makeSettings(), "GET", "/utilities/ping").catch((e) => e);
    expect(err).toMatchObject({ status: 0, retryable: true });
  });

  it("treats 429 and 5xx as retryable", () => {
    expect(new AvaTaxError(429, undefined, "x").retryable).toBe(true);
    expect(new AvaTaxError(503, undefined, "x").retryable).toBe(true);
    expect(new AvaTaxError(404, "EntityNotFoundError", "x").retryable).toBe(false);
  });
});

describe("connectionError", () => {
  it("explains each kind of failure", () => {
    expect(connectionError(new AvaTaxError(0, undefined, "x"))).toContain("could not be reached");
    expect(connectionError(new AvaTaxError(401, "AuthenticationException", "x"))).toContain("account ID or license key");
    expect(connectionError(new AvaTaxError(403, undefined, "nope"))).toContain("refused");
    expect(connectionError(new AvaTaxError(429, undefined, "x"))).toContain("limiting requests");
    expect(connectionError(new AvaTaxError(500, undefined, "x"))).toContain("not responding");
    expect(connectionError(new AvaTaxError(400, "InvalidAddress", "bad zip"))).toBe("AvaTax 400 InvalidAddress: bad zip");
    expect(connectionError(new Error("boom"))).toBe("AvaTax could not be reached: boom");
  });
});
