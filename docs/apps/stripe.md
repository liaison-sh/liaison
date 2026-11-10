---
title: Connect Stripe
description: "Connect your Stripe account with a restricted key so Liaison keeps a read mirror of customers, subscriptions, invoices and payments."
---

The Stripe connector links your Stripe account to Liaison. Liaison keeps a read mirror of your customers, subscriptions, invoices, payments, refunds and disputes, so people and agents read money facts from it.

Stripe is a connector: it has no screen of its own yet. It appears as a card on **Settings › Connectors**.

This page grows as the connector does. Today the connector stores its tables and its connection; it does not yet take webhook events.

## Create a restricted key

Liaison never asks for your secret key. It uses a restricted key with these permissions:

- **Read:** Customers, Subscriptions, Invoices, Charges, Disputes, Payment methods, Products, Prices, Events.
- **Write:** Refunds.

Leave every other permission at None. In the Stripe Dashboard, open **Developers → API keys → Create restricted key**.

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
| Admin | Also connect the account and manage its key and webhook |

Connecting needs `stripe:admin:connection`. See [Connect apps](../connecting-apps.md).
