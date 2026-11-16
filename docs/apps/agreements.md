---
title: Prepare agreements
description: "Draft proposals, statements of work, contracts and any PDF, keep templates with versions, and decide who in the organization can see each agreement."
---

The Agreements app keeps your proposals, statements of work, contracts and any PDF you upload as drafts, checks them before they go out for a simple electronic signature, and keeps the templates they come from.

## Draft an agreement

Ask an agent, or use the app: an agreement starts as a draft from a template, a short brief, or an uploaded PDF (kind **other**, where a person says what the document is). Every agreement gets its number from its series: `PR-` for proposals, `DOC-` for an uploaded PDF, `AG-` for the rest, with the year.

An agent never sets a price. A person sets it on the agreement's page. A proposal, a statement of work or a retainer without a price cannot be prepared.

Clauses an agent wrote are marked as drafts. They block the checks until a person reads them and saves the text.

## Check before sending

**Prepare** runs the checks a document needs before it is sent:

- a document tagged as a guarantee, real estate, family or employment document cannot be signed here;
- a text that looks like a personal guarantee waits until a person changes its kind or says it is not one;
- minutes of a meeting, a written consultation or a filing pass with a note: check with your lawyer first, since some of these acts need a higher signature level, which Liaison does not offer;
- a proposal needs its price, a PDF needs a person's statement of what it is, and every agent clause needs a person's reading.

## Keep templates with versions

Saving a template makes a new version. An agreement copies the text of the version it was made from, so a later version never changes it. A template shows or hides a block on one field's equality only. An agent's template save waits for a person's approval.

## Decide who can see an agreement

Each agreement has an organization access (none, viewer, editor) and a list of named people. With **none**, only the people on the list can read the agreement, its drafts, versions, signatures and evidence, whatever role or permission anyone else holds, administrators included. The person who creates an agreement starts on its list as an editor. The list is never empty, a viewer cannot change it, and an agent's change waits for a person.

## Scopes

| Scope | Lets you |
|---|---|
| `agreements:agreements:read` | Read agreements and templates |
| `agreements:agreements:write` | Draft, change, price and prepare agreements |
| `agreements:evidence:read` | Read signature records and evidence |
| `agreements:evidence:devices` | See signers' device details |
| `agreements:templates:write` | Save templates |
| `agreements:approve` | Decide a card an agent's change is waiting on (who can see an agreement, a template save) |
| `agreements:internal` | Used by the app itself |
