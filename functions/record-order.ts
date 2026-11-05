import { loadSettings } from './lib/avatax';
import { SALE_FIELDS, salesModel, syncSale } from './lib/sales';

export const config: SwellConfig = {
  description: 'Record paid orders and invoices in AvaTax',
  model: {
    // payments, cancellations and refunds come as their own events, not as order.updated with the changed field
    events: [
      'order.created',
      'order.updated',
      'order.paid',
      'order.canceled',
      'order.refunded',
      'invoice.created',
      'invoice.updated',
      'invoice.payment_succeeded',
      'invoice.refunded',
    ],
  },
};

// true when the event changed something AvaTax records (updated events carry only the changed fields in $event.data)
export function isSaleChange(event: any): boolean {
  if (!String(event?.type || '').endsWith('.updated')) return true;
  const changed = event?.data || {};
  return SALE_FIELDS.some((field) => field in changed);
}

export default async function (req: SwellRequest) {
  const event = req.data.$event;
  const model = salesModel(event?.type);
  const id = req.data.id;
  if (!model || !id || !isSaleChange(event)) return;

  const settings = await loadSettings(req.swell);
  if (!settings?.record_sales) return;

  return { outcome: await syncSale(req.swell, settings, model, id) };
}
