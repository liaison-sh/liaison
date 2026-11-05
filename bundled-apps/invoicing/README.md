# invoicing — financial-document issuer

Issues and reconciles financial documents — **invoices, quotes, proformas,
purchase orders, and credit notes** — with gap-free numbering at issue, tax
treatment derived from the counterparty's country (domestic VAT / intra-EU
reverse-charge / zero-rated export with HS codes), PDF rendering, and VAT-number
validation against the official EU VIES service. Money is in **minor units**
throughout.

## Tools (surface)

- **Read:** `documents_search`, `documents_get`, `documents_for_orders`,
  `documents_download_pdf`, `documents_preview_pdf`, `hs_codes_lookup`,
  `pending_approvals_list`, `deferred_list`, `vat_validate`,
  `contact_relationships_get`.
- **Draft:** `drafts_create`, `drafts_update`, `drafts_discard`.
- **Issue:** `invoice_issue` / `invoice_create_and_issue`,
  `quote_create_and_issue`, `proforma_issue` / `proforma_create_and_issue`,
  `credit_note_issue` / `credit_note_create_and_issue`,
  `documents_convert_to_invoice`, `hs_codes_assign`.
- **Lifecycle:** `documents_update`, `documents_send_to_customer`,
  `documents_mark_paid`, `documents_record_refund`, `documents_retry_pdf`.
- **Settings:** `settings_issuer_profile_list/create/update/delete`,
  `settings_tax_regime_list`, `settings_hs_code_list`,
  `settings_shop_mapping_list`.

See the manifest `agentInstructions` for the issuing/tax/numbering discipline.

**Who may change an issuer profile.** Reading a profile needs
`invoicing:settings:read` and editing its ordinary fields needs
`invoicing:settings:write`. Changing a bank or control field (`iban`,
`swift_bic`, `bank_name`, the two approval thresholds, `require_two_eyes`,
`auto_email_enabled`, `mail_account_id`), or deleting a profile, also needs
`invoicing:issuer:admin`. The admin role holds it; grant it to another role (a
C-level or finance role) from the role editor. No member tier carries it, so the
auto-maintained Full Member role never does.

## Connecting

Read [`docs/connecting-apps.md`](../../docs/connecting-apps.md) for the shared
connection machinery. **Invoicing declares no connection of its own** — it holds
no external credentials. Its only egress is `ec.europa.eu` (the EU VIES VAT
service, used by `vat_validate`), declared directly in the manifest `network`
allowlist rather than through a connected account.

**How it is driven — auto-invoice on paid order.** Invoicing runs a **built-in,
app-internal order-paid auto-flow**: when a Shopify order is **paid**, invoicing
issues that order's invoice automatically, threshold-gated by the issuer profile
(over `invoice_approval_threshold` → an approval; under → auto-issue), and
auto-emailed if `auto_email` is on.

Key facts about this flow (and how to configure it):

- The paid signal is Shopify's `orders/paid` **webhook**, consumed by invoicing's
  **own handler** — it is **not** a kernel event. Shopify emits
  `order:created/updated/fulfilled/cancelled` on the bus, but **there is no
  `order:paid` kernel event**, so this is not something you wire with an agent
  routine (event or cron).
- Enable it purely by **configuration**: confirm an issuer profile exists
  (`settings_issuer_profile_list`), map the Shopify shop to it
  (`settings_shop_mapping_list` → `issuer_profiles.shopify_shop_id`), and set the
  approval threshold + `auto_email` on the profile.
- **Without the shop mapping** the paid webhook parks `awaiting_config` and
  nothing issues — the mapping is the switch that turns the auto-flow on.

So "auto-issue an invoice whenever an order is paid" is a configuration of the
issuer profile + shop mapping, not a connection and not a routine.

## Quotes are Shopify draft orders

When an issuer profile is mapped to a Shopify shop
(`issuer_profiles.shopify_shop_id`) and the shopify app is installed, a quote and
a Shopify draft order are **one object seen from two sides**. There is no copy to
keep in step by hand and no second place to create the offer.

- **Creating.** `quote_create_and_issue` creates the draft order in Shopify and
  the quote appears mirroring it. A draft order created on the Shopify side (the
  admin UI, or `shopify:draft_orders_create`) creates the quote automatically.
  Either route is correct; both produce the same quote, built by the same code.
- **Editing.** Every later change in Shopify flows back through the
  `shopify/draft_order:*` events. A quote still in `sent` is refreshed in place
  (lines, discounts, carriage, the Bill-to snapshot); an accepted, rejected,
  expired or invoiced quote is a settled record and is left alone.
- **Converting.** `documents_convert_to_invoice` on a linked quote **completes
  the draft order in Shopify** with payment pending (a B2B customer pays against
  the invoice, not at checkout). Shopify creates the real order, and the
  order-paid auto-flow above issues the invoice from it. The convert returns
  `mode: "shopify_order_created"` and the quote becomes `invoiced`; the invoice
  itself follows moments later.
- **Deleting.** Deleting the draft order in Shopify rejects the quote.
- **Standalone.** With no shop mapping the app works exactly as before: a local
  quote, and converting it issues the invoice directly (`mode: "local"`).

Two handles carry the link, mirroring the order pair below:
`shopify_draft_order_id` (the gid, and the idempotency key: a partial UNIQUE
index means one quote per draft order no matter how often an event is replayed)
and `shopify_draft_order_name` (the human reference, `#D12`).

The events carry two different payload shapes: the Shopify webhooks publish the
full normalized draft order, while the tool path publishes the raw mutation
result. So the sync trusts only the event's `entityId` and re-fetches through
`shopify:draft_orders_get` whenever line items are absent. A draft order whose
customer has no address yet is not an error: the sync waits, and the update that
adds the address creates the quote.

**There is no user-facing draft document category.** Only quotes, proformas and
purchase orders are started by hand. Invoices come from orders or from converting
a quote or proforma, and credit notes come from refunds.

### Prices and tax

A document always **stores net prices** and adds the tax it computed from the
customer's country. What changes is what a price you TYPE means, and that is the
issuer profile's `prices_include_tax` setting.

- **Off (default).** A typed price is net. Type 100.00 for a French customer and
  the document reads 100.00 plus 20.00 VAT, total 120.00.
- **On.** A typed price is gross, tax included. Type 120.00 for the same customer
  and the document reads 100.00 plus 20.00 VAT, total 120.00: the VAT is taken
  out of the price you typed, not added to it.

**Set it to match your Shopify shop.** Shopify has the same choice ("include tax
in prices"), and when the issuer profile is mapped to a shop the two must agree,
or the same figure means two different prices depending on where it was typed. A
quote created here goes to Shopify as a draft order at the price given, and the
draft order comes back priced by the shop, so a mismatch shows up as a total that
is off by the VAT. The sync logs a warning when it sees one.

Two things are never affected by the setting: a line with no tax on it (reverse
charge, export) has no included tax to remove, so it stays exactly as typed; and
a catalog line (a Shopify variant) always takes the store price, whatever is
typed next to it.

## The store order reference

A document that bills a Shopify order carries **two** handles, and they are not
interchangeable:

- `shopify_order_id` — the numeric/gid API handle (`12768069779622`). Used for
  idempotency (one invoice per order, per scope and shipment batch) and for
  `shopify:orders_get` lookups.
- `shopify_order_number` — the **human order name** (`#1149`). This is what the
  customer quotes, what the store's order list shows, and what an operator types
  into search. It is printed in the PDF header ("Order: #1149"), shown in the
  documents list and detail view, matched by `documents_search`'s free-text
  query, and resolvable through `documents_for_orders`.

Writers of the human reference: the order-paid auto-flow (from the webhook's
`name`, with `shopify:orders_get` as a fallback), the CSV importer
(`order_number`), and an agent passing `shopify_order_number` to `drafts_create`
/ `invoice_create_and_issue` / `proforma_create_and_issue`. Never synthesise one
from the numeric id — an invented reference matches nothing in the store.

Documents issued before v0.9.0 carry no reference. The one-time
`backfill-order-numbers` job fills it in (from `external_refs` where the importer
already recorded it, else one `shopify:orders_get` per unique order), marks each
document in its `lifecycle_log` so it converges and self-terminates, and **does
not re-render any PDF** — an already-issued invoice keeps the exact artifact the
customer received. Remove the job once prod reports nothing remaining.
