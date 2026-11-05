# pennylane — accounting connector

Connects a deployment's [Pennylane](https://pennylane.com) accounting book to
Liaison so agents can answer finance questions from the live ledger: spend, P&L,
cash, accounts-payable, margin, and runway. Money is always in **minor units**
(every money field carries a `_minor` suffix — divide by 100 for euros). P&L and
runway are **derived**: gross margin = revenue − COGS over a trial balance classed
by account-code prefix; runway = cash / trailing net burn.

## Tools

| Tool | What it does |
|---|---|
| `supplier_invoices_list` / `supplier_invoice_get` | Accounts-payable invoices (bills you owe) — the authoritative AP source. |
| `customer_invoices_list` | Accounts-receivable invoices as booked in the ledger. |
| `trial_balance_get` | Trial balance for a period (account code, label, balance). |
| `pnl_summary` | Derived P&L for a period (`revenue_minor`, `cogs_minor`, `opex_minor`, `gross_margin_minor`). |
| `cash_position` | Current cash per account + `total_by_currency`. |
| `transactions_list` | Bank transactions (burn side). |
| `spend_by_category` | Spend aggregated by P&L class for a period. |
| `runway_estimate` | Runway in whole months (cash / trailing net burn). |
| `home_load` | Cached P&L + cash snapshot for the home view. |
| `supplier_invoice_upload` | **Gated, stage-not-post.** Captures a received vendor bill as an AP record; on approval it only *stages* the document (`posted_to_pennylane: false`) — the final file-into-Pennylane step is a human action. |

## Connecting

Read [`docs/connecting-apps.md`](../../docs/connecting-apps.md) first for the
shared connection machinery (credentials type, ownership + the
`not_connected`-for-others isolation gotcha, the domain allowlist). This section
specialises it for pennylane.

**Connection:** one `credentials` connection named `pennylane`. Its only egress
host is `app.pennylane.com` (the connection's `allowedDomains`).

| Field | Where it comes from |
|---|---|
| `apiToken` | An API token you generate in Pennylane. For a **company**: account settings (needs an Executive or Accountant role) → generate a Company API token. For a **firm**: Firm settings → Firm Tokens → Generate an API Token. **The token is shown once and cannot be retrieved later — copy it immediately.** Docs: <https://pennylane.readme.io/docs/generating-my-api-token>. |
| `scope` | `company` or `firm` — must match **where the token was created**. This tells the connector which Pennylane API surface the token addresses; a mismatch fails the reads. |

**What `scope` controls, and the bank caveat.** `scope` selects the token's
Pennylane surface (company vs firm), and the granular V2 scopes you grant the
token at creation decide what it can read (invoices, trial balance,
transactions). If the token **lacks the bank scope**, `cash_position` and
`runway_estimate` honestly report `cash_status: "unavailable"` and `months: null`
rather than inventing a number — grant the bank scope on the token if you need
cash/runway.

For a shared company book agents must reach, connect it **org-owned**
(`mode: "org"`, needs `pennylane:accounts:admin`); a user-owned connection
returns `not_connected` for everyone else.
