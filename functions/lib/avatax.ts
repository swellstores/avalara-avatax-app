export const APP_ID = 'avatax';

// id of the tax extension in swell.json; Settings → Taxes saves it as extension_config_id
export const EXTENSION_ID = 'avatax';

// AvaTax REST API v2 hosts, chosen by the Environment setting
export const API_HOSTS = {
  sandbox: 'https://sandbox-rest.avatax.com/api/v2',
  production: 'https://rest.avatax.com/api/v2',
} as const;

export type Environment = keyof typeof API_HOSTS;

// Sent in X-Avalara-Client as "app name; app version; adapter; adapter version; machine".
export const CLIENT_HEADER = 'Swell; 1.0.0; REST; v2; Swell';

// AvaTax tax codes used when a product or shipping service has none
export const DEFAULT_PRODUCT_TAX_CODE = 'P0000000';
export const DEFAULT_SHIPPING_TAX_CODE = 'FR030000';

// the parts of the Swell client the app uses
export interface SwellClient {
  get(path: string, data?: any): Promise<any>;
  settings(): Promise<any>;
}

export interface AvaTaxSettings {
  environment: Environment;
  account_id: string;
  license_key: string;
  company_code: string;
  block_on_failure: boolean;
  product_tax_code: string;
  shipping_tax_code: string;
  record_sales: boolean;
}

// Error returned by the AvaTax API (or a network failure when status is 0)
export class AvaTaxError extends Error {
  status: number;
  // AvaTax error code, e.g. AuthenticationException, EntityNotFoundError, InvalidAddress
  code: string | undefined;
  // the call AvaTax refused, e.g. "POST /transactions/createoradjust" (no query string)
  endpoint: string | undefined;

  constructor(status: number, code: string | undefined, message: string, endpoint?: string) {
    super(`AvaTax ${status}${code ? ` ${code}` : ''}: ${message}`);
    this.name = 'AvaTaxError';
    this.status = status;
    this.code = code;
    this.endpoint = endpoint;
  }

  // message with the refused call, for logs
  get detail(): string {
    return this.endpoint ? `${this.message} (${this.endpoint})` : this.message;
  }

  // network errors, rate limits and server errors are worth retrying
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

// AvaTax error codes the app handles
export const NOT_FOUND = 'EntityNotFoundError';
export const ALREADY_VOIDED = 'TransactionAlreadyCancelled';

// read app settings and apply defaults for values the merchant has not saved yet
export function getSettings(all: any): AvaTaxSettings {
  const raw = all?.avatax || {};
  const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

  return {
    environment: raw.environment === 'production' ? 'production' : 'sandbox',
    account_id: text(raw.account_id),
    license_key: text(raw.license_key),
    company_code: text(raw.company_code),
    block_on_failure: flag(raw.block_on_failure, true),
    product_tax_code: text(raw.product_tax_code).toUpperCase() || DEFAULT_PRODUCT_TAX_CODE,
    shipping_tax_code: text(raw.shipping_tax_code).toUpperCase() || DEFAULT_SHIPPING_TAX_CODE,
    record_sales: flag(raw.record_sales, true),
  };
}

// the settings the app needs before it can call AvaTax
export function missingSettings(settings: AvaTaxSettings): string[] {
  const missing: string[] = [];
  if (!settings.account_id) missing.push('account ID');
  if (!settings.license_key) missing.push('license key');
  if (!settings.company_code) missing.push('company code');
  return missing;
}

// load settings and check the app can call AvaTax; null when it's not set up
export async function loadSettings(swell: Pick<SwellClient, 'settings'>): Promise<AvaTaxSettings | null> {
  const settings = getSettings(await swell.settings());
  const missing = missingSettings(settings);
  if (missing.length) {
    console.error(`AvaTax: missing ${missing.join(', ')} in app settings`);
    return null;
  }
  return settings;
}

// Basic auth with the account ID and license key
function authorization(settings: Pick<AvaTaxSettings, 'account_id' | 'license_key'>): string {
  const bytes = new TextEncoder().encode(`${settings.account_id}:${settings.license_key}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

// call AvaTax; returns the parsed JSON response (or null for empty responses)
export async function avataxRequest(
  settings: Pick<AvaTaxSettings, 'environment' | 'account_id' | 'license_key'>,
  method: 'GET' | 'POST',
  path: string,
  body?: object,
): Promise<any> {
  const endpoint = `${method} ${path.split('?')[0]}`;
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: authorization(settings),
    'x-avalara-client': CLIENT_HEADER,
  };
  if (body) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_HOSTS[settings.environment]}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err: any) {
    throw new AvaTaxError(0, undefined, err?.message || String(err), endpoint);
  }

  const text = await res.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  // AvaTax reports errors as { error: { code, message, details: [{ description, ... }] } }
  if (!res.ok || json?.error) {
    const error = json?.error || {};
    const detail = Array.isArray(error.details) ? error.details[0] : undefined;
    const message = detail?.description || detail?.message || error.message || text || res.statusText;
    throw new AvaTaxError(res.ok ? 400 : res.status, error.code || undefined, message, endpoint);
  }
  return json;
}

// merchant-facing explanation of a failed AvaTax call
export function connectionError(err: unknown): string {
  if (!(err instanceof AvaTaxError)) {
    return `AvaTax could not be reached: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (err.status === 0) {
    return 'AvaTax could not be reached. Try again in a few minutes.';
  }
  if (err.status === 401 || err.code === 'AuthenticationException') {
    return 'AvaTax rejected the account ID or license key. Check them, and that the Environment matches the account (sandbox accounts work only with Sandbox).';
  }
  if (err.status === 403) {
    return `AvaTax refused the request: ${err.message}. Check that the account has access to this company and to AvaTax.`;
  }
  if (err.status === 429) {
    return 'AvaTax is limiting requests right now. Try again in a few minutes.';
  }
  if (err.status >= 500) {
    return 'AvaTax is not responding right now. Try again in a few minutes.';
  }
  return err.message;
}
