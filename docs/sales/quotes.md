---
title: Send quotes and follow-up documents
description: "Create a quote in Invoicing, email it to the customer, keep it in step with a Shopify draft order, and turn it into an invoice."
---

Quotes live in the Invoicing app. This page covers the sales side: creating a quote, sending it, how a quote and a Shopify draft order stay one object, and converting an accepted quote into an invoice. For issuer profiles, numbering, tax and every invoicing tool, see [Issue invoices and quotes](../apps/invoicing.md).

You need an issuer profile before anything can be issued. See [Create an issuer profile](../apps/invoicing.md#create-an-issuer-profile).

## Create a quote

1. Open **Invoicing** and click **+ New quote** in the sidebar. The arrow next to it offers **New proforma** and **New purchase order** instead.
2. Pick the **Issuer**, then the **Issue date** and **Due date**.
3. Optionally, search a contact in **Contact** and pick it: the document is linked to that contact, which shows by its name, and an empty customer name and email are filled from it. **Unlink** removes the link.
4. Fill in **Customer name**, **Customer email**, **Customer VAT ID**, **Customer country** and **Customer address**. Add a **Shipping address (if different)** if needed. The country decides the tax treatment.
5. Click **+ Add line** for each line.
6. Click **Preview PDF** to check it.
7. Click **Create quote**, or **Create quote + email** to also email it to the customer.

The quote gets its number and its PDF. When the issuer profile is mapped to a Shopify shop and the draft order needs approval in Shopify first, you see **Draft order sent for approval in Shopify. The quote appears once it is approved.**

A price you type means net or gross depending on the issuer profile's **Prices include tax** setting. Match it to your Shopify shop's setting. See [Issue invoices and quotes](../apps/invoicing.md#create-an-issuer-profile).

A line can carry a discount: the total off that line in minor units (cents), not per unit and not a percentage. A quote can also carry a **Customer ref**, your reference for the customer in another system such as a CRM record id, printed on the PDF. An agent that creates a quote gets back its number and the id of its PDF, so the same request can attach the PDF to a reply.

## Send a quote to the customer

1. Open the quote from **Documents › Quotes** in the sidebar.
2. Click **Send to customer**.

You see **Sent to the customer.**, or **Sent for approval.** when the send waits for a person to approve it. An agent's send (`documents_send_to_customer`) always waits for approval.

## Quotes and Shopify draft orders

When the issuer profile is mapped to a Shopify shop, a quote and a Shopify draft order are one object seen from two sides:

- Creating a quote here creates the draft order in Shopify. A draft order created in Shopify creates the quote here.
- Editing the draft order in Shopify updates a quote that is still `sent`. A quote that is accepted, rejected, expired or invoiced is left alone.
- Deleting the draft order in Shopify rejects the quote.

Create each offer once, here or in Shopify, never in both. Without a shop mapping, the quote stays in Liaison only.

## Turn a quote into an invoice

1. Open the quote. It must be `sent` or `accepted`.
2. Click **Convert to invoice** and confirm.

For a quote linked to a Shopify draft order, this completes the draft order in Shopify with payment pending. Shopify creates the order, the quote becomes `invoiced`, and the invoice is issued from the order moments later. Do not issue a second invoice by hand. A quote without a draft order is converted into an invoice at once.

Convert to invoice is refused when the order would not be invoiced: the Shopify customer has no email, the draft order has no address, a buyer in another EU country is charged no VAT without its VAT number, or a reverse charge sale is charged VAT. The message says what to fix. A quote with the buyer's VAT number creates its draft order with that number as a `VAT number` custom attribute, so the order keeps the reverse charge.

When you click the button yourself, the confirmation is the approval. An agent's convert (`documents_convert_to_invoice`) files an approval first. The quote's customer purchase order number (`po_number`) is carried onto the invoice.

## Quote statuses

| Status | Meaning |
| --- | --- |
| `sent` | Issued and waiting for the customer |
| `accepted` | Accepted, not yet converted |
| `invoiced` | Converted into an invoice |
| `rejected` | Declined, or its Shopify draft order was deleted |
| `expired` | No longer valid |

## Other documents for a deal

| Document | When to use it | How it starts |
| --- | --- | --- |
| Proforma | A provisional invoice sent before the real one | **New proforma**, then **Issue proforma**. Converts to an invoice like a quote |
| Purchase order | An order you send to a supplier | **New purchase order**, then **Issue purchase order** |
| Credit note | A correction of an issued invoice | Comes from a refund or cancellation, with its own `CN-` numbers |

## What agents can do

| Tool | What it does | Approval |
| --- | --- | --- |
| `quote_create_and_issue` | Create a quote, and its Shopify draft order when the shop is mapped | Over the issuer's threshold, when not mapped to a shop |
| `quote_issue` | Issue a quote from a legacy draft | Always |
| `documents_send_to_customer` | Email a document to the customer | Always |
| `documents_convert_to_invoice` | Convert a quote or proforma into an invoice | Always |
| `proforma_create_and_issue`, `po_create_and_issue` | Issue a proforma or a purchase order | See [Issue invoices and quotes](../apps/invoicing.md#what-agents-can-do) |

When a quote waits for approval, its card shows the customer, each line with its quantity, price and discount, the total, how long the quote is valid (**Valid until**) and the customer reference (**Customer ref**). A quote that is one step of a larger request (a CRM record, then the quote, then the reply that sends it) shows the same card inside that request. See [Approve several steps in one go](../agents/approvals.md#approve-several-steps-in-one-go).

An agent can also create the draft order on the Shopify side with `shopify__draft_orders_create`. The quote then appears by itself, so it must not create both. See [Store](../apps/store.md).

## Related pages

- [Research prospects and draft replies](research-prospects.md)
- [Approve what agents do](../agents/approvals.md)
