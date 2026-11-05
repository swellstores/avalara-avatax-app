export interface MockRequestOptions {
  data?: SwellData;
  query?: { [key: string]: string };
  session?: { [key: string]: any };
  headers?: Record<string, string>;
  method?: string;
  url?: string;
  swell?: Partial<SwellAPI>;
  store?: Partial<SwellStore>;
  appId?: string;
}

function createDefaultSwellMock(): Partial<SwellAPI> {
  const notMocked = (method: string) => () => {
    throw new Error(
      `swell.${method}() not mocked. Pass { swell: { ${method}: vi.fn() } } to createMockRequest().`
    );
  };
  return {
    get: notMocked("get"),
    post: notMocked("post"),
    put: notMocked("put"),
    delete: notMocked("delete"),
    settings: notMocked("settings"),
  };
}

export function createMockRequest(options: MockRequestOptions = {}): SwellRequest {
  const {
    data = {},
    query = {},
    session = {},
    headers = {},
    method = "POST",
    url = "https://example.com/test",
    swell,
    store,
    appId,
  } = options;

  const requestHeaders = new Headers(headers);
  // The app tsconfig's webworker lib does not type URLSearchParams as iterable
  const urlQuery: Record<string, string> = {};
  new URL(url).searchParams.forEach((value, key) => {
    urlQuery[key] = value;
  });
  const requestQuery = { ...urlQuery, ...query };
  const originalRequest = new Request(url, {
    method,
    headers: requestHeaders,
    body: method === "GET" ? undefined : JSON.stringify(data),
  });

  const storeId = store?.id || "test-store";

  const resolvedStore = {
    id: storeId,
    url: store?.url || "",
    admin_url: store?.admin_url || "",
  };

  const context = {
    waitUntil: async (promise: Promise<unknown>) => {
      await promise;
    },
  };

  const swellClient = swell || createDefaultSwellMock();

  const resolvedAppId = appId || "avatax";

  const req: Partial<SwellRequest> & { appId: string; storeId: string } = {
    originalRequest,
    context,
    url: new URL(url),
    method,
    headers: requestHeaders,
    referrer: originalRequest.referrer,
    credentials: "include",
    appId: resolvedAppId,
    storeId,
    accessToken: null,
    publicKey: null,
    store: resolvedStore,
    session,
    apiHost: "",
    logParams: undefined,
    swell: swellClient as SwellAPI,
    rawBody: method === "GET" ? "" : JSON.stringify(data),
    body: method === "GET" ? "" : { ...data },
    data: { ...(method === "GET" ? {} : data), ...requestQuery },
    query: requestQuery,
    initialize: async () => {},
    parseJson: (input: string) => {
      try { return JSON.parse(input); } catch { return {}; }
    },
    reject: (
      code: string,
      message: string,
      options: { status?: number } = {}
    ) => {
      return new SwellRejection(code, message, options);
    },
    appValues: (idOrValues: string | SwellData, values?: SwellData) => {
      const targetAppId =
        typeof idOrValues === "string" ? idOrValues : resolvedAppId;
      const appValues = typeof idOrValues === "string" ? values : idOrValues;
      if (!targetAppId) {
        throw new Error("appValues: missing app id (req.appId is empty)");
      }
      if (
        typeof appValues !== "object" ||
        appValues === null ||
        Object.getPrototypeOf(appValues) !== Object.prototype
      ) {
        throw new Error(
          "appValues: values must be a plain object (arrays, class instances, null, and primitives are not allowed)"
        );
      }
      return {
        $app: {
          [targetAppId]: appValues,
        },
      };
    },
  };

  return req as SwellRequest;
}
