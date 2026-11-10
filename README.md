# Avalara AvaTax integration

A Swell tax app that calculates sales tax with [Avalara AvaTax](https://www.avalara.com/us/en/products/calculations.html)
for carts, orders and subscriptions, and records paid orders and invoices in AvaTax as committed sales (except invoices
created from an order, which bill the order's sale), so they appear in AvaTax reports and returns. Customers can be marked tax-exempt on their customer page. The app connects
with an AvaTax **account ID** and **license key**.

It is a tax extension (`extensions` in `swell.json`, id `avatax`): once it's turned on in **Settings → Taxes**, Swell
asks the app for taxes instead of using its own tax rules.

## Features

### Connection

Every call goes to the AvaTax REST API v2: `https://sandbox-rest.avatax.com/api/v2` or `https://rest.avatax.com/api/v2`,
picked by the **Environment** setting (`avataxRequest` in `functions/lib/avatax.ts`). Requests use basic auth with the
account ID and license key, and send `X-Avalara-Client: Swell; 1.0.4; REST; v2; Swell` (the version follows `swell.json`), which names the app to
Avalara's support (no partner connector id; AvaTax doesn't require one). Errors keep AvaTax's error code (for example
`InvalidAddress`), the first detail's description, and the refused call (for example
`POST /transactions/createoradjust`), and are logged with all three. A 2xx response that carries an `error` object is
treated as an error with status 400.

### Tax calculation

`functions/calculate-taxes.ts` is the extension's `before:order.taxes` hook. Swell runs it whenever it recalculates the
taxes of a cart, order or subscription (items, quantities, addresses, coupons or promotions change, or the order is
submitted). Invoices don't run it: Swell copies their taxes from the order or subscription. The hook gets
the change being saved and the saved record (`$record`); the app combines them into the current record.

It calculates nothing and returns no taxes when:

- the account ID, license key or company code is missing (the hook returns before loading anything and logs what's
  missing);
- the record has `taxes_fixed`;
- neither the shipping nor the billing address has a zip code, or a street, city and state;
- there are no items, no subscription plan item and no shipping service.

Otherwise it loads the shipping locations (`/settings/shipments/locations`), the **Taxable location** setting
(`/settings/taxes` → `location_source`), the customer (`/accounts/{id}`, for the email and exemption), and the products of
items that don't have them (one `/products` call: name, SKU, type, delivery, tax code), then sends a `SalesOrder`
transaction with `commit: false` to `POST /transactions/createoradjust`. AvaTax doesn't save `SalesOrder` documents.

The transaction has:

| AvaTax field | From Swell |
|---|---|
| `type`, `commit` | `SalesOrder`, `false` |
| `companyCode` | the **Company code** setting |
| `date` | today, `YYYY-MM-DD` |
| `customerCode` | the customer's email, lowercased; else the account ID; else `guest` |
| `entityUseCode`, `exemptionNo` | the customer's **Entity use code**, and with it the **Exemption number** (see Customer exemptions) |
| `currencyCode` | the record's currency |
| `lines` | see Lines below |

The result goes back to Swell (`model.fields`: `items`, `taxes`, `shipment_tax`, `product_taxes`):

- each item: `taxes: [{ id: "avatax", amount }]`, the tax of its line (`tax`, else `taxCalculated`);
- `shipment_tax`: the tax of the shipping line, or 0;
- `taxes`: one tax `{ id: "avatax", name: "<type> tax", amount, shipping: true }`, where the type is the first
  `summary` entry's `taxType` (usually `Sales`) and the amount is the items' and shipping's tax; `shipping` is set only
  when there is a shipping line;
- subscriptions: the plan product (`product_id`, outside `items`) is sent as one more line and its tax returned as
  `product_taxes`. During a trial (`trial`) the plan isn't sent.

Swell merges items by `id`, so only the tax fields of each item change.

### Lines

`buildLines` in `functions/lib/transactions.ts` makes the lines, numbered from 1:

| Line | Quantity | Amount | Item code | Tax code |
|---|---|---|---|---|
| each item | `quantity_total`, else `quantity` | `price_total` − `discount_total` | product SKU (50 characters) | product's **Tax code**; physical gift cards `PG050000`, digital gift cards `DG020000`; else **Default product tax code** |
| returned units of an item (`quantity_returned` and `return_price_total`) | `quantity_returned` | −(`return_price_total` − `return_discount_total`) | same as the item | same as the item |
| shipping, when `shipping.service` is set | 1 | `shipment_total` | the service id in capitals with `_` → `-`, ending with `-SHIPPING` (50 characters, keeping the end) | the service's `tax_code` in `shipment_rating.services`; else **Shipping tax code** |
| restocking fee, when `return_credit_total` is set | 1 | −`return_credit_total` | `Restock fee` | `OR040000` |

Descriptions are the product name and the shipping service name (2096 characters). Lines get `taxIncluded: true` when
the record's prices include tax: items, returns and the restocking fee when `item_tax_included` (or a subscription's
`tax_included`) is set, shipping when `shipment_tax_included` is set.

Addresses, per line:

- **Ship to**: the first of the shipping and billing address (billing first when **Settings → Taxes → Taxable location**
  is the billing address) that has a zip code, or a street, city and state.
- **Ship from**: the item's `shipment_location`, else the shipping location with id `default`. The shipping and
  restocking-fee lines ship from the items' shared location, or `default` when the items ship from different ones.
- Sent as `shipFrom` + `shipTo`; as one `singleLocation` (the customer's address) when there's no ship-from address or
  it has neither a zip nor a street, city and state.
- When the customer has no usable address (only possible when recording a sale, see below), the line uses the ship-from
  location as `singleLocation`.

### When AvaTax fails

Any failure while calculating (AvaTax refuses the transaction, can't be reached or doesn't answer in time, a Swell call
fails, or the hook runs out of time) is logged as
`AvaTax: taxes not calculated: …`. Then:

- **Reject when AvaTax fails** off: the hook returns no taxes, and the change is saved without tax.
- **Reject when AvaTax fails** on (default): the hook rejects the change (`req.reject`, status 422, code
  `avatax_failed`) with "Taxes could not be calculated. " followed by the reason, for example "AvaTax could not be
  reached. Try again in a few minutes." The cart or order change isn't saved.

Swell waits 10 seconds for the hook; a hook that runs longer or crashes ends with the change saved without tax, and the
reject setting can't apply, so the app must answer first. The hook gives itself 8 seconds from its start
(`HOOK_DEADLINE_MS` in `functions/lib/avatax.ts`), Swell reads included:

- Loading the locations, customer and products from Swell stops at the deadline with "Calculating took too long. Try
  again in a few minutes."
- The AvaTax call stops after 6 seconds (`REQUEST_TIMEOUT_MS`), or sooner when less time is left, with "AvaTax didn't
  answer in time. Try again in a few minutes." With no time left, it isn't made and the first message applies.

Every other AvaTax call (Test connection, recording sales) stops after 6 seconds with the same message.

### Recording sales

`functions/record-order.ts` runs on `order.created`, `order.updated`, `order.paid`, `order.canceled`, `order.refunded`,
`invoice.created`, `invoice.updated`, `invoice.payment_succeeded` and `invoice.refunded`. A payment comes as `order.paid`
with only the order id and payment id, not as an `order.updated` that changes `paid`, so those events are needed.
`*.updated` is handled only when the change (`$event.data`) touches `paid`, `canceled`, `void`, `items`, `shipping`,
`billing`, `shipment_total`, `shipment_rating`, `return_credit_total`, `account_id`, `currency` or `taxes_fixed`. With
**Record paid orders in AvaTax** off, or a credential missing, it returns before loading the record. It also records
nothing while another tax service is selected in **Settings → Taxes** (`extension_config_id` isn't `avatax`), since
those orders were taxed by that service.

The order or invoice is loaded again (with `items.product` and `account`, and `subscription` for invoices), then:

| Record | What happens |
|---|---|
| not found, or without a number | nothing |
| `taxes_fixed` | nothing |
| invoice with an `order_id` | nothing; it bills the same sale as its order, which is recorded |
| canceled order (`canceled`) or voided invoice (`void`) | the AvaTax document is voided (`POST /companies/{company}/transactions/{code}/void?documentType=SalesInvoice`, `{ "code": "DocVoided" }`). A document AvaTax doesn't have (`EntityNotFoundError`) or that's already voided (`TransactionAlreadyCancelled`) counts as done. |
| not paid | nothing; AvaTax gets the sale once it's paid |
| paid | a `SalesInvoice` with `commit: true` is sent to `POST /transactions/createoradjust`, built like the calculation above, with `code` and `purchaseOrderNo` = the document code and `date` = the record's creation date |

The document code is the order number, or `I-<number>` for invoices. `createoradjust` updates the document when the code
already exists, so later changes (items, returns, addresses) replace what AvaTax has, and a repeated event doesn't
create a second document.

An invoice without its own addresses uses its subscription's shipping and billing address. A paid record whose customer
has no usable address is recorded from the store's `default` shipping location; without that location it isn't recorded
(`AvaTax: <model> <code> not recorded: no customer address and no default shipping location` is logged).

Network errors, 429 and 5xx are thrown, so the call ends as failed and the event can be delivered again (safe: the
same code updates the same document).
Other AvaTax errors (for example a locked document AvaTax has already filed) are logged as
`AvaTax: <model> <code> not recorded: …` and not retried.

### Customer exemptions

`models/accounts.json` adds two fields to customers (`$app.avatax`), shown on the customer page's **AvaTax** tab
(`content/accounts.json`):

| Field | Sent as | Values |
|---|---|---|
| Entity use code | `entityUseCode` | None, or one of AvaTax's standard codes A–R (for example G resale, E charitable organization, A federal government) |
| Exemption number | `exemptionNo` | optional certificate number, sent only with an entity use code |

They're sent with every calculation and recorded sale of that customer. AvaTax exempts the whole sale whenever
`exemptionNo` is set, whatever the reason, so a number without an entity use code isn't sent (`exemption` in
`functions/lib/transactions.ts`). Guest checkouts have customer records too, so a guest can be exempted the same way.
The customer code is the email in both calculation and recording, so exemption certificates saved in Avalara for that
email apply as well.

### Test connection

The **Test connection** action calls `GET /utilities/ping` and checks `authenticated`, then looks up the company code
(`GET /companies?$filter=companyCode eq '<code>'`) and checks it's active. It answers "Connected to AvaTax (Sandbox),
company <name>." and notes when recording sales is off. When Swell's built-in Avalara AvaTax integration is also
connected (`/settings/integrations` → `services.avatax.enabled` is truthy, as Swell treats it), it warns to disconnect
it in **Integrations**: that integration keeps recording orders with the same document codes, so it overwrites the app's
documents (dropping exemptions) with the same company, or records each sale twice with another one. If that check
fails, the warning is left out and the failure is logged. It works before AvaTax is selected in **Settings → Taxes** and
sends no store data. Missing credentials, wrong credentials, an unknown or inactive company and AvaTax errors show as a
red error popup (a `SwellError` with status 400); only temporary errors say "try again".

### Turning the app off

The app has no Enabled setting. Tax calculation runs only while AvaTax is the selected tax service in **Settings →
Taxes**; choose another service there to use Swell's own tax rules. That also stops recording sales, and orders
canceled after the switch aren't voided in AvaTax (void them in AvaTax). To stop only recording, turn off **Record paid
orders in AvaTax**.

## Settings

All credentials and options are set by the merchant in the app settings (`settings/avatax.json`) and are never stored in
code.

| Setting | Required | Default | Description |
|---|---|---|---|
| Environment | no | Sandbox | Sandbox or Production; must match the AvaTax account. |
| Account ID | yes | | AvaTax → Settings → License and API keys. |
| License key | yes | | Generated on the same page. Stored as a secret. |
| Company code | yes | | AvaTax → Settings → Manage companies. |
| **Tax calculation** | | | |
| Reject when AvaTax fails | no | on | Rejects the cart or order change when AvaTax can't calculate, instead of saving it without tax. |
| Default product tax code | no | `P0000000` | For products without a tax code. |
| Shipping tax code | no | `FR030000` | For shipping services without a tax code. |
| **Recording sales** | | | |
| Record paid orders in AvaTax | no | on | Records paid orders and invoices (except invoices created from an order) as committed sales; voids them when canceled. |

Tax codes are trimmed and uppercased. **Actions**: **Test connection**.

## Setup

1. In AvaTax, open **Settings → License and API keys**: note the **account ID** and generate a **license key**
   (generating a new key stops the previous one). Note the **company code** in **Settings → Manage companies**. Sandbox
   accounts are separate from production ones and need the **Sandbox** environment.
2. Install the app in Swell, open its settings, enter the environment, account ID, license key and company code, and
   save. Run **Test connection**; it should say "Connected to AvaTax".
3. In Swell, open **Settings → Taxes**, turn on **Avalara AvaTax** and click **Save changes**. Only one tax service can be
   active; this replaces any other one. Until this step Swell doesn't call the app.
4. Check the store's shipping locations: the location with id `default` (and any per-product locations) is the
   ship-from address. Set product tax codes (`tax_code`) where the default isn't right, with **Edit products**, an
   import or the API. Shipping service tax codes (`tax_code` in `/settings/shipments` → `services`) are set through the
   API.
5. Add an address to a test cart: its taxes come from AvaTax. Pay a test order: it appears in AvaTax → **Transactions**
   with the order number as its code.

`swell inspect extensions app.avatax.avatax` shows whether the extension is activated.

## Limits and known behavior

- **One tax line.** AvaTax's jurisdiction breakdown (state, county, city) isn't copied to Swell; the order shows one
  "Sales tax" with the total.
- **Recording uses the current record.** The recorded tax is AvaTax's calculation at recording time, which can differ
  from the tax the customer saw if rates changed in between.
- **Refunds without returns** don't change the AvaTax document; returned items (with a return price) and restocking fees
  do.
- **Unpaid orders aren't recorded.** An order is sent when it's paid; canceling it before then leaves nothing in AvaTax.
- **Calls per calculation.** Each recalculation makes up to 5 Swell calls (app settings, locations, tax settings,
  customer, products) and one AvaTax call. Each recorded sale reloads the record and reads the tax settings once, for
  both the tax service check and the address setting.

## Development

### Project layout

```
functions/
  calculate-taxes.ts     # tax extension hook: before:order.taxes → AvaTax SalesOrder
  record-order.ts        # order/invoice events → committed SalesInvoice, or void when canceled
  test-connection.ts     # settings action: credentials and company code
  lib/avatax.ts          # settings, API client, errors and their messages
  lib/transactions.ts    # lines, addresses, tax codes, customer and exemption, transaction model, void
  lib/sales.ts           # recording a paid order or invoice
models/accounts.json     # exemption fields on customers ($app.avatax)
content/accounts.json    # AvaTax tab on the customer page
settings/avatax.json     # merchant settings and the Test connection action
assets/icon.png          # app icon (official Avalara mark)
assets/screenshots/      # listing screenshots, referenced by `images` in swell.json
test/unit/               # vitest unit tests (AvaTax API mocked)
```

### Commands

```bash
npm run typecheck                          # TypeScript check for functions and tests
npm test                                   # run all vitest tests
swell app push                             # deploy to the test environment (--force after changing only functions/lib/*)
swell inspect functions --app=.            # check deployed functions
swell inspect extensions app.avatax.avatax # check the tax extension is activated
swell logs --type function -s AvaTax       # function logs
```

Tests run in the Cloudflare Workers runtime. Unit tests mock `fetch` by AvaTax endpoint
(`test/helpers/avatax-fixtures.ts`), so no real AvaTax calls are made.

To try it end to end, use an AvaTax sandbox account, set its credentials in the test environment, turn AvaTax on in
**Settings → Taxes**, and add an address to a cart.
