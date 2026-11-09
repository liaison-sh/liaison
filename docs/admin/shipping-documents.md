---
title: Generate shipping papers automatically
description: Set up document templates, product facts and document rules so the papers a parcel needs (customs declarations, certifications) are generated for every order, regenerated with the tracking number and printed with the pack.
---

Some parcels need papers nobody would guess from the order: a declaration of the metal in the goods, a chemical-substances certification, a statement for one country. Liaison generates them for you once three things are set up, all as data:

1. **Product facts**: what each product is made of, kept by SKU (product attributes).
2. **Document templates**: the text and layout of each paper, filled from the order.
3. **Document rules**: which templates an order needs, by destination country, SKU, carrier or product fact.

No code and no deploy: an admin, or an agent with the admin's approval, sets them up with tool calls.

## What happens to an order

- **To prepare.** When the shipping worklist refreshes, every order on **To prepare** is checked against the rules for the record type `boxtal:order`. Each template a rule asks for is printed as a PDF and kept on the order. A scheduled pass every 10 minutes does the same for orders the refresh did not reach.
- **Label bought.** Right after the label buy, the papers are printed again with the carrier, the shipping date and, as soon as the carrier gives it, the tracking number (the **AWB** for FedEx). A tracking number that arrives later is picked up by the scheduled pass.
- **Nothing changed, nothing printed.** A paper is printed again only when the order's data changed since its last print. A template the rules no longer ask for is dropped from the order's list.
- **Ready to ship.** The row's **Paperwork** mark names the papers, and **Print pack** returns them with the invoice, for the A4 printer, brought up to date first.

## Keep product facts

Product facts are product attributes: a SKU, a key and a value, set with `kernel__product_attributes_upsert`. Templates read them as `lines.attributes.<key>`, and rules can match on them.

**Never fill in a fact nobody has confirmed.** Leave it unset: the template prints its grey words for it (for example "not confirmed by the supplier") and the PDF lists it as a blank to complete. Update the attribute once the supplier confirms the value in writing; the next print uses it.

## Write a template

Create the template with `kernel__document_template_create`, record type `boxtal:order` and kind `rich_text`. `order_print_record_get` shows the fields an order holds: the invoice (number and date), the delivery address (`order.address_lines`), phone, email, customer PO number and incoterm, the shipment (carrier, tracking number, `shipment.reference`, shipping date), the totals, and the goods lines with SKU, HS code, origin, quantity, net unit value and their product facts. The issue date is `issued_on`.

A body is a list of blocks: `heading`, `paragraph`, `list`, `table`, `repeat`, `image` and `spacer`.

- `{{path}}` prints a value. A missing value prints grey as `[label]` and is listed as a blank.
- `{{path ?? words}}` prints the words, grey, when the value is missing (still a blank to fill). `{{path ??}}` prints nothing (an optional field, such as a phone number nobody gave).
- `when` on any block prints it only when its conditions hold. A condition is `{ "path": ..., "is": "present" | "absent" }`, `{ "path": ..., "equals": ... }` or `{ "path": ..., "in": [...] }`; a list of conditions must all hold. A `*` in the path means any line: `lines.*.attributes.material` equals `steel` holds when any line is made of steel.
- `table` prints a header and one row per line of `from` (keep some lines with `where`), or the fixed `rows` you write. A fixed row can carry its own `when`.
- `repeat` prints its blocks once per kept line of `from`: a section per product.
- Inside a row, a path reads the line first and the order when the line has no such field, so `{{invoice.number}}` still works there.
- Signature and stamp: upload the images onto the template, then add `image` blocks with their file ids.

Preview it on a real order with `kernel__document_template_preview` and its `recordId` (the order's invoice document id).

## Write the rules

Add a rule with `kernel__document_rules_upsert`, record type `boxtal:order`. `when` takes `countryIso2`, `sku`, `carrier` and `attribute`. `attribute` maps a product fact to the values that trigger the rule: `{ "material": ["steel"] }` holds when any SKU of the order has that fact, and `"*"` means any value. Every condition you give must hold. Several rules may name the same template; it is printed once.

Example: every order to the US needs a certification, and an order with a steel product also needs a steel declaration:

```json
{ "recordType": "boxtal:order", "name": "US: certification", "when": { "countryIso2": ["US"] }, "templateIds": ["<certification>"] }
{ "recordType": "boxtal:order", "name": "US: steel", "when": { "countryIso2": ["US"], "attribute": { "material": ["steel"] } }, "templateIds": ["<steel declaration>"] }
```

## Stop asking for a paper

The worklist's own attention rules (`attention_rule_upsert`, `attention_rule_delete`) can name papers too, as text. When such a paper has no template, edit the rule to drop it, or turn the rule off, so the row stops asking for something nobody can print.
