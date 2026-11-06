# boxtal — carrier shipping connector

Shipping over the Boxtal carrier network: carrier **quotes**, **shipments**
(outbound and prepaid returns), **tracking**, and **customs documents**, plus a
local shipping catalog (per-product profiles, packs, local products). A shipment
draft opens from an order's issued invoice; creating a shipment is **gated**
(propose → human approves), and tracking is read-only.

## Tools (surface)

- **Catalog:** `packages_list`, `product_profile_upsert`, `pack_upsert`,
  `pack_delete`, `local_product_upsert`, `settings_sender_address_get/set`.
- **Quote & draft:** `quote` (carrier rates for a draft or a direct route),
  `shipment_draft_create`, `shipment_draft_get`, `set_package`, `set_customs`.
- **Ship (gated):** `create_shipment` (outbound; `is_return: true` for a prepaid
  return label — swaps addresses, stamps `kind='return'`).
- **Read / triage:** `search`, `track`, `queue_counts`, `to_prepare_list`,
  `exceptions_list`, `stuck_list`, `returns_list`, `get_documents`.
- **Order prep queue:** `prep_list`, `prep_sync`, `prep_set_status`,
  `prep_set_category`, `prep_select_offer`, `prep_exclude`, `prep_restore`,
  `prep_add_shipment`, `prep_document_pdf`, `prep_order_prefill`.

(Use `tool_search` to discover the deferred read tools; see the manifest's
`agentInstructions` for the shipping-triage discipline.)

## The order prep queue ("To prepare")

The screen the logistics operator works from, and the app's largest surface.

**One row per OPEN, UNFULFILLED Shopify order**, not per issued invoice. An order
with no invoice yet is still a row (it says so, and it can be excluded); it used to
be structurally invisible. A row leaves the queue when Shopify reports the order
fulfilled (the label webhook does that) or when the operator excludes it.

Two ids per row:

| Id | What it is |
|---|---|
| `order_key` | The row. `so:<shopify order id>`, or `doc:<document id>` / `pending:<token>` for a shipment with no order behind it. Status, category and exclusion are keyed by this, so a row with no document can still be held or excluded. |
| `document_ref` | The row's **anchor**: the document its packages, customs articles and quote derive from. Nullable. |

**Status** (`prep_set_status`): `to_prepare`, `validated`, `on_hold`. One per row,
and the whole row is tinted from it. `on_hold` is a warehouse fact (waiting on
stock, on a customer, on a repair), so it lives here rather than in a Shopify tag:
it must be settable on a row with no document and it must block shipping without
touching the store. `prep_set_validated` is an alias onto it, kept for screens and hidden from agents.

**Category decides the shipping document** (`prep_set_category`):

| Category | Ships on |
|---|---|
| `sale` | The order's issued commercial invoice. |
| `repair` (return after repair), `gift` (sample) | A **proforma the app issues** at the org's nominal value (`settings_packaging_policy_get`) through the invoicing app, with **one line per physical item** at real quantities and catalog references, so the parcels and the customs declaration match what is in the box. The row re-anchors on it. |

Issuing that proforma is gated in invoicing, so it can come back pending approval;
the category is then locked until the answer lands, and the scan adopts the
document by its correlation ref (`shipment_ref = "prep:<order_key>"`) as soon as it
exists. `prep_add_shipment` creates an order-less row on the same path.

**Cost, and why the grid used to feel like a page reload.** The list read resolves
**no** shipment drafts: it builds from `prep_meta`, `prep_quote`, `prep_state` and
`prep_draft_cache`, and a row whose anchor has no cache entry honestly reports
`not_synced`. Draft resolution happens in `prep_sync` (Pull orders, bounded) and in
the row-scoped read (`prep_list {order_keys}`). Every row action re-reads **its own
row** through that scoped read and patches it in place; only Pull orders, Refresh
stale and the Show excluded toggle re-read the whole list. Which is which is data
(`mutationPlan` in `src/ui/prep-row-logic.ts`) and a test fails if a row action is
wired to a whole-list refetch.

**Package resolution is deterministic** (`resolver.ts`, shipping profiles and
packs). No model is in that path, and `manifest.test.ts` fails if one appears.

## Connecting

Read [`docs/connecting-apps.md`](../../docs/connecting-apps.md) first for the
shared connection machinery (credentials type, ownership + the
`not_connected`-for-others isolation gotcha). This section specialises it for
boxtal.

**Connection:** one `credentials` connection named `boxtal`. Boxtal spans **two
API generations** and needs a key pair for each:

| Field | Where it comes from |
|---|---|
| `v1Key` / `v1Secret` | The legacy **EnvoiMoinsCher v1** key + secret, generated in your Boxtal account's API/developer area. |
| `v3Key` / `v3Secret` | The current **Boxtal v3** access key + secret, from the same account area. |
| `environment` | `sandbox` (→ `test.envoimoinscher.com` / `api.boxtal.build`) or `production` (→ `www.envoimoinscher.com` / `api.boxtal.com`). |

Create a free account at [boxtal.com](https://boxtal.com) — a **test** account
for sandbox, a normal account for production — then generate **both** key pairs
and pick the matching `environment`. Developer docs:
<https://developer.boxtal.com/>. The four Boxtal hosts above are the connection's
`allowedDomains`; the app never fetches anything else.

For a shared company Boxtal account agents must reach, connect it **org-owned**
(`mode: "org"`, needs `boxtal:accounts:admin`); a user-owned connection returns
`not_connected` for everyone else.

**Inbound tracking webhook.** Boxtal also POSTs tracking/document-created events
back to the app's `tracking-changed` / `document-created` webhooks, HMAC-verified
under a kernel-minted secret surfaced via `webhookSecretConfigKey`
(`boxtalWebhookSecret`).

## Failure modes

Creating a shipment refuses rather than reporting a silent success when a draft
is not shippable. The block reasons (from the resolver / customs builder) are:

| Reason | Meaning | Fix |
|---|---|---|
| `no_profile` | An order line has no resolved shipping profile | Add the product's profile (`product_profile_upsert`) so the parcel resolves. |
| `missing_weight` | The parcel (or a customs article) has no weight | `set_package` to give the parcel a real weight/dimensions. |
| Missing HS code / origin | An **export** customs article lacks an HS code or country of origin (surfaced as the `to_prepare_list` "Missing HS code" defect / a Boxtal 422) | `set_customs` to set each export line's HS code + origin. |
| Missing customs value | An export article has no unit value | Set the article's value before quoting/creating. |

Attachment size: a document/label pulled onto a reply is subject to the kernel's
file-size cap — an over-cap file is rejected rather than truncated. Nothing is
shipped until a human approves each gated `create_shipment` — never report a label
as created before that approval returns.
