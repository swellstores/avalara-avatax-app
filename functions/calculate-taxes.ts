import {
  AvaTaxError,
  type AvaTaxSettings,
  DeadlineError,
  HOOK_DEADLINE_MS,
  REQUEST_TIMEOUT_MS,
  beforeDeadline,
  connectionError,
  getSettings,
  loadSettings,
} from './lib/avatax';
import {
  TAX_ID,
  buildLines,
  createOrAdjust,
  documentDate,
  hasCustomerAddress,
  loadAccount,
  loadLocations,
  round,
  transactionModel,
  withProducts,
} from './lib/transactions';

export const config: SwellConfig = {
  extension: 'avatax',
  description: 'Calculate taxes with AvaTax',
  model: {
    // before: replaces Swell's own tax rules, and can reject the change when the setting asks for it
    events: ['before:order.taxes'],
    fields: ['items', 'taxes', 'shipment_tax', 'product_taxes'],
  },
};

// the record being calculated: the saved record with this change applied, without $event and $record
function currentRecord(data: Record<string, any>): Record<string, any> {
  const record: Record<string, any> = { ...(data.$record || {}) };
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith('$')) record[key] = value;
  }
  return record;
}

// Runs whenever Swell recalculates taxes of a cart, order or subscription; invoices copy the taxes of theirs.
// Returns nothing (no tax) when the app is not set up, or the customer has no address yet.
export default async function (req: SwellRequest) {
  const deadline = Date.now() + HOOK_DEADLINE_MS;
  let settings: AvaTaxSettings | null;
  try {
    settings = await beforeDeadline(loadSettings(req.swell), deadline, 'loading the app settings');
  } catch (err) {
    // Without settings it's unknown whether Reject is on; follow its default (on),
    // so a hung or failed read doesn't quietly save the change without tax.
    return failed(req, err, getSettings(undefined).block_on_failure);
  }
  if (!settings) return;

  const record = currentRecord(req.data);
  if (record.taxes_fixed || !hasCustomerAddress(record)) return;

  const items: any[] = Array.isArray(record.items) ? [...record.items] : [];
  // a subscription keeps its plan product outside items; its tax goes to product_taxes
  const planItem =
    record.product_id && !record.trial
      ? {
          product_id: record.product_id,
          variant_id: record.variant_id,
          quantity: record.quantity ?? 1,
          price_total: record.price_total,
          discount_total: record.product_discount_total ?? 0,
        }
      : undefined;
  if (planItem) items.push(planItem);
  if (!items.length && !record.shipping?.service) return;

  try {
    const [locations, account, linesItems] = await beforeDeadline(
      Promise.all([loadLocations(req.swell), loadAccount(req.swell, record), withProducts(req.swell, items)]),
      deadline,
      'loading the record from Swell',
    );
    const context = { ...locations, account };
    const built = buildLines(record, linesItems, context, settings);
    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now());
    const transaction = await createOrAdjust(
      settings,
      transactionModel(record, built.lines, context, settings, { code: undefined, date: documentDate(), record: false }),
      timeoutMs,
    ).catch((err) => {
      // When the Swell reads used up part of the time, AvaTax got less than REQUEST_TIMEOUT_MS.
      // Its timeout then reports the hook's deadline ("Calculating took too long"), not AvaTax being slow.
      if (timeoutMs < REQUEST_TIMEOUT_MS && err instanceof AvaTaxError && err.code === 'Timeout') {
        throw new DeadlineError(`waiting for AvaTax (${err.detail})`);
      }
      throw err;
    });
    return taxResult(transaction, built, planItem !== undefined, items);
  } catch (err) {
    return failed(req, err, settings.block_on_failure);
  }
}

// Logs why taxes were not calculated, then rejects the change (reject = the Reject when AvaTax fails setting)
// or returns no tax so the change is saved without it.
function failed(req: SwellRequest, err: unknown, reject: boolean): undefined {
  console.error(`AvaTax: taxes not calculated: ${err instanceof AvaTaxError ? err.detail : err instanceof Error ? err.message : String(err)}`);
  if (reject) {
    throw req.reject('avatax_failed', `Taxes could not be calculated. ${connectionError(err)}`, { status: 422 });
  }
  return undefined;
}

// AvaTax's response → item taxes, shipping tax and the order's AvaTax tax line
function taxResult(
  transaction: any,
  built: { itemLines: string[]; shippingLine: string | undefined },
  hasPlanItem: boolean,
  items: any[],
) {
  const taxByLine = new Map<string, number>();
  for (const line of transaction?.lines || []) {
    taxByLine.set(String(line.lineNumber), round(line.tax ?? line.taxCalculated ?? 0));
  }
  const lineTax = (number: string | undefined) => (number ? taxByLine.get(number) ?? 0 : 0);

  const itemTaxes = built.itemLines.map((number) => lineTax(number));
  const shipmentTax = lineTax(built.shippingLine);
  const amount = round(itemTaxes.reduce((sum, tax) => sum + tax, shipmentTax));
  const type = transaction?.summary?.[0]?.taxType || 'Sales';

  const result: Record<string, any> = {
    items: [],
    shipment_tax: shipmentTax,
    taxes: [{ id: TAX_ID, name: `${type} tax`, amount, ...(built.shippingLine ? { shipping: true } : {}) }],
  };

  const count = hasPlanItem ? items.length - 1 : items.length;
  for (let i = 0; i < count; i++) {
    if (items[i]?.id) result.items.push({ id: items[i].id, taxes: [{ id: TAX_ID, amount: itemTaxes[i] }] });
  }
  if (hasPlanItem) {
    result.product_taxes = [{ id: TAX_ID, amount: itemTaxes[items.length - 1] }];
  }
  return result;
}
