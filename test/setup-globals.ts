import { SwellError } from "@swell/apps-sdk";

class SwellRejectionImpl extends Error {
  status: number;
  code: string;
  body: {
    $reject: {
      code: string;
      message: string;
      status: number;
    };
  };

  constructor(code: string, message: string, options: { status?: number } = {}) {
    const status =
      typeof options.status === "number" &&
      options.status >= 400 &&
      options.status < 500
        ? options.status
        : 422;

    super(message || "Request rejected by function");
    this.name = "SwellRejection";
    this.status = status;
    this.code = code;
    this.body = {
      $reject: {
        code,
        message: this.message,
        status,
      },
    };
  }
}

// Builds the body and content type like the deployed function runtime
class SwellResponseImpl extends Response {
  constructor(
    data?: string | object,
    options: ResponseInit & { headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = {};
    let body = "";

    if (typeof data === "string") {
      body = data;
      headers["Content-Type"] = "text/plain;charset=UTF-8";
    } else if (data !== undefined) {
      body = JSON.stringify(data, null, 2);
      headers["Content-Type"] = "application/json;charset=UTF-8";
    }

    super(body, {
      status: 200,
      ...options,
      headers: { ...headers, ...options.headers },
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).SwellError = SwellError;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).SwellRejection = SwellRejectionImpl;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).SwellResponse = SwellResponseImpl;

export {};
