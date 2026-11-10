---
title: Connect Stripe
description: "Connect your Stripe account with a restricted key so Liaison keeps a read mirror of customers, subscriptions, invoices and payments."
---

The Stripe connector links your Stripe account to Liaison. Liaison keeps a read mirror of your customers, subscriptions, invoices, payments, refunds and disputes, so people and agents read money facts from it.

Stripe is a connector: it has no screen of its own yet. It appears as a card on **Settings › Connectors**.

This page grows as the connector does. Today the connector stores its tables, its connection and the result of its key check; it does not yet take webhook events.

## Create a restricted key

Liaison never asks for your secret key. It uses a restricted key with exactly these permissions:

| Permission | Level |
|---|---|
| Customers | Read |
| Subscriptions | Read |
| Invoices | Read |
| Charges | Read |
| Disputes | Read |
| Payment methods | Read |
| Products | Read |
| Prices | Read |
| Events | Read |
| Refunds | Write |

Leave every other permission at None.

1. In the Stripe Dashboard, open **Developers → API keys → Create restricted key**.
2. Set the permissions in the table above, and create the key. It starts with `rk_live_` (live mode) or `rk_test_` (test mode).
3. In Liaison, paste it into **Restricted key** on the Stripe card. The key is stored encrypted, and the connector's code never sees it: the server adds it to each request.

A secret key (`sk_live_` or `sk_test_`) is refused before anything is stored: the card says "That is your secret key, so I did not keep it." Create a restricted key and paste that one instead.

## Check the key

After the key is saved, ask the agent to check it (it uses `connection_check`, which needs `stripe:admin:connection`). The check makes one read per permission above and a refund probe on a charge that cannot exist, so nothing is created in Stripe. It answers ten rows, one per permission:

- **Read works** or **Write allowed**: the permission is there.
- **Missing: give Read to Disputes** (for example): that permission is missing. The connection stays usable; what that permission covers is not read until you add it to the key in Stripe and run the check again.

Liaison also runs this check on a new key before it keeps it. The check refuses, and the key already saved stays the one Liaison uses, when:

| Answer | What happened | What to do |
|---|---|---|
| `key_invalid` | Stripe refused the key: it was revoked, rolled or mistyped | Create a new restricted key and save it |
| `different_account` | None of the records Liaison already holds exists in the key's account | Save the key of the account Liaison is connected to, or disconnect Stripe fully first |
| `mode_changed` | The key is a live-mode key and Liaison holds test-mode data, or the other way round | Save a key of the same mode, or disconnect Stripe fully first |

Stripe does not let a restricted key show the account name, so the check does not name the account.

## What Liaison stores

- Customers, subscriptions, invoices, payments, refunds and disputes, with amounts in minor units.
- For a card: its brand, its last 4 digits and its expiry. Never the card number or the security code.
- No raw webhook body and no Stripe `metadata`.

Every request goes to `api.stripe.com` only, with a pinned API version. The key is added to each request by the server, so the connector's code never holds it.

## Who sees what

| Role of the app | Can |
|---|---|
| Member | Read customers, subscriptions, invoices, payments, refunds and disputes |
| Billing | Also link customers to companies and contacts, and request refunds and cancellations |
| Admin | Also connect the account, check its key and manage its webhook |

| Scope | Lets a person or an agent |
|---|---|
| `stripe:customers:read` | Read customers |
| `stripe:customers:write` | Link a customer to a company or a contact |
| `stripe:subscriptions:read` | Read subscriptions |
| `stripe:subscriptions:write` | Request a subscription's cancellation (approved by a person) |
| `stripe:invoices:read` | Read invoices |
| `stripe:payments:read` | Read payments, refunds and disputes |
| `stripe:refunds:write` | Request a refund (approved by a person) |
| `stripe:admin:connection` | Connect the account, check its key and manage its webhook |
| `stripe:approve` | Decide Stripe approvals |
| `stripe:internal` | Used by the app itself |

Connecting needs `stripe:admin:connection`. See [Connect apps](../connecting-apps.md).

## Scopes

| Scope | What it allows |
| --- | --- |
| `stripe:customers:read` | Read customers |
| `stripe:subscriptions:read` | Read subscriptions and their revenue changes |
| `stripe:invoices:read` | Read invoices |
| `stripe:payments:read` | Read payments, refunds and disputes |
| `stripe:customers:write` | Link customers to companies and contacts |
| `stripe:refunds:write` | Request refunds |
| `stripe:subscriptions:write` | Request cancellations |
| `stripe:admin:connection` | Connect the account and manage its key and webhook |
| `stripe:internal` | Used by the app itself |

Member holds the four read scopes, Billing adds the three write scopes, Admin adds the connection.
