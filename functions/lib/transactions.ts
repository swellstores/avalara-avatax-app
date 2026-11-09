import {
  ALREADY_VOIDED,
  APP_ID,
  AvaTaxError,
  EXTENSION_ID,
  NOT_FOUND,
  avataxRequest,
  type AvaTaxSettings,
  type SwellClient,
} from './avatax';

// id of the tax the app adds to items and to the order's taxes
export const TAX_ID = 'avatax';

// AvaTax field limits
const ITEM_CODE_LENGTH = 50;
const DESCRIPTION_LENGTH = 2096;

// tax codes AvaTax uses for gift cards and restocking fees
const PHYSICAL_GIFT_CARD_TAX_CODE = 'PG050000';
const DIGITAL_GIFT_CARD_TAX_CODE = 'DG020000';
const RESTOCKING_FEE_TAX_CODE = 'OR040000';

// product fields the lines need
const PRODUCT_FIELDS = 'id,name,sku,type,delivery,tax_code';

export const round = (value: number) => Math.round((Number(value) || 0) * 100) / 100;

export interface AvaTaxAddress {
  line1?: string;
  city?: string;
  region?: string;
  country?: string;
  postalCode?: string;
}

export interface AvaTaxLine {
  number: string;
  quantity: number;
  amount: number;
  itemCode?: string;
  description?: string;
  taxCode: string;
  taxIncluded?: boolean;
  addresses?: { singleLocation: AvaTaxAddress } | { shipFrom: AvaTaxAddress; shipTo: AvaTaxAddress };
}

// what the lines and the transaction need besides the record itself
export interface TaxContext {
  // Swell shipping locations by id; "default" is the store's main location
  locations: Map<string, any>;
  // Settings → Taxes → "Taxable location": shipping (default) or billing address
  locationSource: string | undefined;
  // the record's customer, with the app's exemption fields
  account: any;
}

// Swell address → AvaTax address
export function toAvaTaxAddress(address: any): AvaTaxAddress {
  return {
    line1: address?.address1 || undefined,
    city: address?.city || undefined,
    region: address?.state || undefined,
    country: address?.country || undefined,
    postalCode: address?.zip || undefined,
  };
}

// AvaTax can find the tax jurisdiction from a zip, or from street, city and state
// (checkout's express payment buttons share only part of the address until the order is placed)
export function isUsableAddress(address: any): boolean {
  return Boolean(address && (address.zip || (address.address1 && address.city && address.state)));
}

function isUsableAvaTaxAddress(address: AvaTaxAddress | undefined): boolean {
  return Boolean(address && (address.postalCode || (address.line1 && address.city && address.region)));
}

// the customer's addresses in the order Settings → Taxes asks for
export function customerAddresses(record: any, locationSource: string | undefined): any[] {
  const addresses = [record?.shipping, record?.billing];
  return locationSource === 'billing' ? addresses.reverse() : addresses;
}

// true when the customer has entered an address AvaTax can calculate taxes for
export function hasCustomerAddress(record: any): boolean {
  return isUsableAddress(record?.shipping) || isUsableAddress(record?.billing);
}

// true when AvaTax can place the sale: the customer's address, or else the store's default location
export function hasTaxAddress(record: any, context: TaxContext): boolean {
  return hasCustomerAddress(record) || isUsableAddress(context.locations.get('default'));
}

// [ship-to address, true when it's the store's own location because the customer has none yet]
function shipTo(record: any, context: TaxContext, fromLocation: any): [AvaTaxAddress | undefined, boolean] {
  for (const address of customerAddresses(record, context.locationSource)) {
    if (isUsableAddress(address)) return [toAvaTaxAddress(address), false];
  }
  if (isUsableAddress(fromLocation)) return [toAvaTaxAddress(fromLocation), true];
  return [undefined, false];
}

// AvaTax line addresses: ship from the location to the customer, or one location when there is only one
function lineAddresses(
  from: AvaTaxAddress | undefined,
  to: AvaTaxAddress | undefined,
  toIsStoreLocation: boolean,
): AvaTaxLine['addresses'] {
  if (!to) return undefined;
  if (toIsStoreLocation || !from || !isUsableAvaTaxAddress(from)) {
    return { singleLocation: toIsStoreLocation && from ? from : to };
  }
  return { shipFrom: from, shipTo: to };
}

// the product's AvaTax tax code; gift cards and products without one get a default
export function productTaxCode(product: any, settings: Pick<AvaTaxSettings, 'product_tax_code'>): string {
  if (product?.tax_code) return String(product.tax_code).trim();
  if (product?.type === 'giftcard') {
    if (product.delivery === 'shipment') return PHYSICAL_GIFT_CARD_TAX_CODE;
    if (product.delivery === 'giftcard') return DIGITAL_GIFT_CARD_TAX_CODE;
  }
  return settings.product_tax_code;
}

// the shipping service's tax code from the shipping rates, or the default one
export function shippingTaxCode(record: any, settings: Pick<AvaTaxSettings, 'shipping_tax_code'>): string {
  const services = record?.shipment_rating?.services;
  const service = Array.isArray(services) ? services.find((s: any) => s?.id === record?.shipping?.service) : undefined;
  return service?.tax_code || settings.shipping_tax_code;
}

// item code of the shipping line; always ends with -SHIPPING so the line can be found in the response
export function shippingItemCode(service: string): string {
  let code = String(service).replace(/_/g, '-').toUpperCase().trim();
  if (!code.endsWith('-SHIPPING')) code = `${code}-SHIPPING`;
  return code.length > ITEM_CODE_LENGTH ? code.slice(code.length - ITEM_CODE_LENGTH) : code;
}

// the item has returned units whose price must be taken off
export function hasReturn(item: any): boolean {
  return Boolean(item?.quantity_returned && item?.return_price_total);
}

// the location the item ships from: its own shipment location, or the store's default one
function itemLocation(item: any, context: TaxContext): any {
  return (item?.shipment_location && context.locations.get(item.shipment_location)) || context.locations.get('default');
}

// the location shipping is charged from: the items' shared location, or the default one
function orderLocation(items: any[], context: TaxContext): any {
  const ids = new Set(items.map((item) => item?.shipment_location || 'default'));
  const id = ids.size === 1 ? [...ids][0] : 'default';
  return context.locations.get(id) || context.locations.get('default');
}

export interface BuiltLines {
  lines: AvaTaxLine[];
  // AvaTax line number of each item, in the order of the items
  itemLines: string[];
  // AvaTax line number of the shipping charge
  shippingLine: string | undefined;
}

// AvaTax lines for the items, returns, shipping and restocking fee of an order, cart, subscription or invoice
export function buildLines(
  record: any,
  items: any[],
  context: TaxContext,
  settings: Pick<AvaTaxSettings, 'product_tax_code' | 'shipping_tax_code'>,
): BuiltLines {
  const lines: AvaTaxLine[] = [];
  const itemLines: string[] = [];
  // subscriptions flag tax-inclusive prices with tax_included
  const itemTaxIncluded = Boolean(record?.item_tax_included || record?.tax_included);
  const included = (flag: boolean) => (flag ? { taxIncluded: true } : {});

  const add = (line: Omit<AvaTaxLine, 'number'>) => {
    const number = String(lines.length + 1);
    lines.push({ number, ...line });
    return number;
  };

  for (const item of items) {
    const product = item?.product;
    const from = itemLocation(item, context);
    const [to, toIsStoreLocation] = shipTo(record, context, from);
    const common = {
      itemCode: product?.sku ? String(product.sku).slice(0, ITEM_CODE_LENGTH) : undefined,
      description: product?.name ? String(product.name).slice(0, DESCRIPTION_LENGTH) : undefined,
      taxCode: productTaxCode(product, settings),
      ...included(itemTaxIncluded),
      addresses: lineAddresses(from && toAvaTaxAddress(from), to, toIsStoreLocation),
    };

    itemLines.push(
      add({
        quantity: Number(item?.quantity_total ?? item?.quantity) || 1,
        amount: round((Number(item?.price_total) || 0) - (Number(item?.discount_total) || 0)),
        ...common,
      }),
    );

    if (hasReturn(item)) {
      // returned units as a negative line; AvaTax works out the tax to give back
      add({
        quantity: Number(item.quantity_returned),
        amount: -round(Number(item.return_price_total) - (Number(item.return_discount_total) || 0)),
        ...common,
      });
    }
  }

  const from = orderLocation(items, context);
  const [to, toIsStoreLocation] = shipTo(record, context, from);
  const addresses = lineAddresses(from && toAvaTaxAddress(from), to, toIsStoreLocation);

  let shippingLine: string | undefined;
  if (record?.shipping?.service) {
    shippingLine = add({
      quantity: 1,
      amount: round(record.shipment_total),
      itemCode: shippingItemCode(record.shipping.service),
      description: record.shipping.service_name ? String(record.shipping.service_name).slice(0, DESCRIPTION_LENGTH) : undefined,
      taxCode: shippingTaxCode(record, settings),
      ...included(Boolean(record.shipment_tax_included)),
      addresses,
    });
  }

  // restocking fee kept from a return; entered in the same terms as item prices
  if (Number(record?.return_credit_total)) {
    add({
      quantity: 1,
      amount: -round(record.return_credit_total),
      itemCode: 'Restock fee',
      description: 'Restocking fee',
      taxCode: RESTOCKING_FEE_TAX_CODE,
      ...included(itemTaxIncluded),
      addresses,
    });
  }

  return { lines, itemLines, shippingLine };
}

// AvaTax customer code: the customer's email, so certificates saved in Avalara for that customer apply
export function customerCode(account: any, record: any): string {
  const email = account?.email || record?.account?.email;
  if (email) return String(email).trim().toLowerCase();
  return record?.account_id ? String(record.account_id) : 'guest';
}

// the customer's exemption fields set on the customer page. AvaTax exempts the whole sale for any exemptionNo,
// so the number is sent only together with an entity use code (the exemption reason).
export function exemption(account: any): { entityUseCode?: string; exemptionNo?: string } {
  const values = account?.$app?.[APP_ID] || {};
  const entityUseCode = typeof values.entity_use_code === 'string' ? values.entity_use_code.trim() : '';
  const exemptionNo = typeof values.exemption_number === 'string' ? values.exemption_number.trim() : '';
  if (!entityUseCode) return {};
  return { entityUseCode, ...(exemptionNo ? { exemptionNo } : {}) };
}

// AvaTax document code of a Swell record: the order number, with a prefix for other record types
export function transactionCode(number: unknown, model: string): string | undefined {
  if (number === undefined || number === null || number === '') return undefined;
  switch (model) {
    case 'carts':
      return `C-${number}`;
    case 'invoices':
      return `I-${number}`;
    case 'subscriptions':
      return `S-${number}`;
    default:
      return String(number);
  }
}

// YYYY-MM-DD, the date format AvaTax documents use
export function documentDate(value?: unknown): string {
  const date = value ? new Date(String(value)) : new Date();
  return (Number.isNaN(date.getTime()) ? new Date() : date).toISOString().slice(0, 10);
}

export interface TransactionOptions {
  code: string | undefined;
  date: string;
  // true records the sale as a committed SalesInvoice; false only calculates (SalesOrder, not saved by AvaTax)
  record: boolean;
}

// the CreateTransactionModel sent to AvaTax
export function transactionModel(
  record: any,
  lines: AvaTaxLine[],
  context: TaxContext,
  settings: Pick<AvaTaxSettings, 'company_code'>,
  options: TransactionOptions,
): Record<string, any> {
  return {
    ...(options.code ? { code: options.code } : {}),
    type: options.record ? 'SalesInvoice' : 'SalesOrder',
    commit: options.record,
    companyCode: settings.company_code,
    date: options.date,
    customerCode: customerCode(context.account, record),
    ...exemption(context.account),
    ...(record?.currency ? { currencyCode: record.currency } : {}),
    ...(options.code ? { purchaseOrderNo: options.code } : {}),
    lines,
  };
}

// create the transaction, or update the one with the same code
export function createOrAdjust(settings: AvaTaxSettings, model: Record<string, any>): Promise<any> {
  return avataxRequest(settings, 'POST', '/transactions/createoradjust', { createTransactionModel: model });
}

// void a recorded transaction; false when AvaTax has none with this code or it's already voided
export async function voidTransaction(settings: AvaTaxSettings, code: string): Promise<boolean> {
  const path = `/companies/${encodeURIComponent(settings.company_code)}/transactions/${encodeURIComponent(code)}/void?documentType=SalesInvoice`;
  try {
    await avataxRequest(settings, 'POST', path, { code: 'DocVoided' });
    return true;
  } catch (err) {
    if (err instanceof AvaTaxError && (err.code === NOT_FOUND || err.code === ALREADY_VOIDED)) {
      return false;
    }
    throw err;
  }
}

// Swell shipping locations and the address Settings → Taxes calculates with;
// taxSettings is /settings/taxes when the caller has already loaded it
export async function loadLocations(
  swell: SwellClient,
  taxSettings?: any,
): Promise<Pick<TaxContext, 'locations' | 'locationSource'>> {
  const [locations, taxes] = await Promise.all([
    swell.get('/settings/shipments/locations'),
    taxSettings !== undefined ? taxSettings : swell.get('/settings/taxes'),
  ]);
  const list = Array.isArray(locations) ? locations : Array.isArray(locations?.results) ? locations.results : [];
  const map = new Map<string, any>();
  for (const location of list) {
    if (location?.id) map.set(location.id, location);
  }
  return { locations: map, locationSource: taxes?.location_source || undefined };
}

// true while Settings → Taxes (/settings/taxes) uses this app's tax extension (extension_config_id is the extension id
// in swell.json; extension_app_id is the app's record id, which functions don't get, so only its presence is checked)
export function isTaxService(taxSettings: any): boolean {
  return Boolean(taxSettings?.extension_app_id) && taxSettings?.extension_config_id === EXTENSION_ID;
}

// the record's customer with the app's exemption fields; null for guests
export async function loadAccount(swell: SwellClient, record: any): Promise<any> {
  if (record?.account?.id && record.account.$app !== undefined) return record.account;
  if (!record?.account_id) return record?.account || null;
  return (await swell.get(`/accounts/${record.account_id}`)) || null;
}

// items with their product's name, SKU, type and tax code, loaded in one call when missing
export async function withProducts(swell: SwellClient, items: any[]): Promise<any[]> {
  const ids = [...new Set(items.filter((item) => !item?.product && item?.product_id).map((item) => item.product_id))];
  if (!ids.length) return items;
  const response = await swell.get('/products', { where: { id: { $in: ids } }, fields: PRODUCT_FIELDS, limit: ids.length });
  const products = new Map<string, any>((response?.results || []).map((p: any) => [p.id, p]));
  return items.map((item) => (item?.product || !item?.product_id ? item : { ...item, product: products.get(item.product_id) }));
}
