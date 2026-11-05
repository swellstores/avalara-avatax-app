import { AvaTaxError, type AvaTaxSettings, type SwellClient } from './avatax';
import {
  buildLines,
  createOrAdjust,
  documentDate,
  hasTaxAddress,
  loadAccount,
  loadLocations,
  transactionCode,
  transactionModel,
  voidTransaction,
  withProducts,
} from './transactions';

export type SalesModel = 'orders' | 'invoices';

// fields whose change can change what AvaTax has recorded for the sale
export const SALE_FIELDS = [
  'paid',
  'canceled',
  'void',
  'items',
  'shipping',
  'billing',
  'shipment_total',
  'shipment_rating',
  'return_credit_total',
  'account_id',
  'currency',
  'taxes_fixed',
];

export type SaleOutcome =
  | 'recorded'
  | 'voided'
  | 'not recorded'
  | 'not found'
  | 'not paid'
  | 'taxes fixed'
  | 'no address'
  | 'failed';

// the record's model from the event type, e.g. "order.updated" → "orders"
export function salesModel(eventType: unknown): SalesModel | undefined {
  const root = String(eventType || '').split('.')[0];
  if (root === 'order') return 'orders';
  if (root === 'invoice') return 'invoices';
  return undefined;
}

// a canceled order or a voided invoice
function isCanceled(record: any): boolean {
  return record?.canceled === true || record?.void === true;
}

// Bring AvaTax up to date with a paid order or invoice: record it as a committed sale with the record's number as
// the document code (AvaTax updates the document when the code is already there), or void it when it's canceled.
// Unpaid records aren't recorded. Temporary AvaTax errors are thrown so the event is retried; others are logged.
// taxSettings is /settings/taxes when the caller has already loaded it.
export async function syncSale(
  swell: SwellClient,
  settings: AvaTaxSettings,
  model: SalesModel,
  id: string,
  taxSettings?: any,
): Promise<SaleOutcome> {
  // reload: the event can arrive after later changes
  const record = await swell.get(`/${model}/${id}`, {
    expand: model === 'invoices' ? ['items.product', 'account', 'subscription'] : ['items.product', 'account'],
  });
  if (!record?.id) return 'not found';
  if (record.taxes_fixed) return 'taxes fixed';

  const code = transactionCode(record.number, model);
  if (!code) return 'not found';

  try {
    if (isCanceled(record)) {
      return (await voidTransaction(settings, code)) ? 'voided' : 'not recorded';
    }
    if (!record.paid) return 'not paid';

    // invoices may have no addresses of their own; the subscription has them
    const sale =
      model === 'invoices' && !record.shipping && !record.billing && record.subscription
        ? { ...record, shipping: record.subscription.shipping, billing: record.subscription.billing }
        : record;

    const [locations, account, items] = await Promise.all([
      loadLocations(swell, taxSettings),
      loadAccount(swell, sale),
      withProducts(swell, Array.isArray(sale.items) ? sale.items : []),
    ]);
    const context = { ...locations, account };
    if (!hasTaxAddress(sale, context)) {
      console.warn(`AvaTax: ${model} ${code} not recorded: no customer address and no default shipping location`);
      return 'no address';
    }

    const { lines } = buildLines(sale, items, context, settings);
    await createOrAdjust(
      settings,
      transactionModel(sale, lines, context, settings, { code, date: documentDate(sale.date_created), record: true }),
    );
    return 'recorded';
  } catch (err) {
    if (err instanceof AvaTaxError) {
      if (err.retryable) throw err;
      console.error(`AvaTax: ${model} ${code} not recorded: ${err.detail}`);
      return 'failed';
    }
    throw err;
  }
}
