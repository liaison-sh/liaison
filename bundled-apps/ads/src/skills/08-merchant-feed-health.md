---
name: 08-merchant-feed-health
description: Merchant feed health: fix product-data issues in the store, route non-data issues manually
kind: playbook
requiredScopes: ["ads:campaigns:read"]
---

# Merchant feed health

Doctrine for keeping the product feed that powers the search-and-shopping
platform's shopping and consolidated-performance campaigns healthy. This playbook
ships as doctrine now; the merchant tools arrive in a later phase. Until they do,
apply these rules when advising, and phrase every read as coming from "the
merchant platform's issue/diagnostics report" — do NOT invent tool names that do
not yet exist in your toolset. The classification and routing rules here are
unchanged once the tools land.

Read the account first. Before advising on feed problems, confirm which
campaigns depend on the feed and what the merchant platform is currently
reporting. State the assumed budget regime (playbook 01) before recommending
structural work.

## Why this matters: feed quality gates all delivery

Hard rule (c): **feed quality gates all delivery on the search-and-shopping
platform.** A product with a disapproved or incomplete feed entry does not serve,
no matter how much budget or how good the bid strategy. This is the same
feed-first principle as playbook 07 (a 99%-complete feed on default bidding beats
a 60%-complete feed on perfect bidding), viewed from the feed side. Disapprovals
and warnings on the feed are therefore the FIRST thing to check when
shopping/performance delivery is low or a product is not showing.

Decision rule: if shopping or feed-driven performance delivery is low, read the
merchant platform's issue report BEFORE touching bids, budget, or campaign
structure. A suppressed feed cannot be fixed above the feed.

## Issue taxonomy: two fundamentally different classes

Every merchant-platform issue falls into one of two classes, and they route
completely differently. Classifying correctly is the core of this playbook.

**Class 1 — product-data issues.** The product's own data in the feed is wrong,
missing, or stale. Examples: missing or mismatched GTIN/identifier, missing
brand, price mismatch between feed and landing page, availability mismatch
(feed says in stock, page says sold out), missing or too-small image, missing
required attribute (color/size/condition), title/description quality, currency
mismatch. These originate in the product record and flow into the feed.

**Class 2 — non-product-data issues.** The problem is NOT in the product record.
Examples: landing-page/website problems (page unreachable, content-policy issues
on the page, crawlability), shipping and tax settings at the account level,
business/domain verification, account-level policy or misrepresentation flags,
returns-policy configuration. These are account, site, or policy configuration,
not fields you edit on a product.

## Routing Class 1: fix in the store, concretely

Hard rule (a): **product-data issues route to concrete store product edits.**
When a Class-1 issue is identified, the resolution is a specific, named edit to
the product record in the store (the same store that syncs the feed). Do not
describe the fix abstractly; name the field and the corrective value.

Procedure:
1. Read the merchant platform's issue report; for each issue, identify the
   affected product(s) and the exact attribute at fault.
2. Confirm it is Class 1 (a field on the product record).
3. Specify the concrete store edit: which product, which field, what the correct
   value is (e.g. "set availability to in stock to match the live page", "add a
   GTIN", "correct the feed price to match the landing-page price of X",
   "replace the image with one at least the minimum required dimensions").
4. After the store edit and the next feed sync, re-check the issue report to
   confirm the disapproval cleared. Feed changes are not instant; allow the sync
   and re-crawl before concluding the fix failed.

Price and availability mismatches are the most common and most damaging Class-1
issues: the platform cross-checks the feed against the live landing page, so the
real fix is to make the feed and the page agree. If they disagree because the
page is right and the feed is stale, fix the feed source (the store product);
if the page is wrong, that edges into Class 2 (landing page).

## Routing Class 2: name the action, take no tool path

Hard rule (b): **non-product-data issues are informational only — name the
merchant platform's recommended action, give NO tool path, and make NO merchant
write.** These issues cannot be fixed by editing a product field, and the correct
resolution lives in account settings, the website, business verification, or a
policy review that a human must perform. Your job is to CLASSIFY and REPORT, not
to act.

For a Class-2 issue:
1. Identify the issue class (landing page, shipping/tax settings, business/domain
   verification, policy/misrepresentation, returns policy, etc.).
2. State the merchant platform's own recommended action in plain terms
   (e.g. "complete domain verification in the merchant account", "configure
   shipping settings for the target country", "the landing page must be reachable
   and match policy", "submit the account for policy re-review after correcting
   the flagged content").
3. Explicitly note this is informational: there is no automated tool path here
   and no merchant write should be attempted. Route it to a human for the
   settings/site/policy change.
4. Do NOT guess account-level settings or attempt to auto-resolve a policy flag.

Never attempt a merchant-side write to resolve a Class-2 issue even once the
merchant tools exist. The write surface is for product-data corrections routed
through the store; account/site/policy configuration is a human, out-of-band
action.

## Prioritization

When multiple issues are present, prioritize by delivery impact:
- Account-level suppressions (business verification incomplete, account-level
  policy flag) can suppress the ENTIRE feed — surface these first even though
  they are Class 2 and human-routed, because nothing else matters until they
  clear.
- Then Class-1 disapprovals on high-value or best-selling products.
- Then warnings that degrade ranking/competitiveness but do not suppress.

Report the impact honestly: "these N products are fully suppressed" is a
different severity from "these have quality warnings but still serve".

## Common Class-1 fixes at a glance

A quick-reference mapping from frequent product-data issues to the concrete store
edit. Each is a field on the product record; each re-checks after the next sync.

- Missing/invalid product identifier -> add the correct GTIN/identifier (or set
  identifier-exists correctly for products that legitimately have none).
- Missing brand -> populate the brand field on the product.
- Price mismatch (feed vs live page) -> correct the feed price so it matches the
  landing page; the platform cross-checks the two.
- Availability mismatch -> set availability to match the live page's true stock
  state.
- Image too small / missing -> replace with an image at least the required
  minimum dimensions.
- Missing required attribute (color/size/condition) -> populate the missing
  attribute for the affected variants.
- Currency mismatch -> correct the feed currency to the target market's currency.

If an item on the issue report is NOT reducible to one of these product-field
edits, it is almost certainly Class 2 — route it per hard rule (b).

## Statistical and reporting honesty

Feed health is largely deterministic (a product is approved or it is not), so it
is a rare place where you can speak in near-certainties rather than the
directional language required for performance metrics. Still, do not overclaim a
delivery recovery from a feed fix until the next sync + re-crawl has actually
cleared the issue and delivery has resumed — report the fix as "applied, pending
re-approval" until confirmed.

## Interaction with other playbooks

- Campaign structure on top of a healthy feed, brand/non-brand split,
  negative-keyword governance, search-terms mining: playbook 07.
- Whether the search-and-shopping platform belongs in the budget mix at all at
  the current regime: playbook 01 and playbook 09.
- Metric honesty for anything downstream of delivery: playbook 04.

## Hard rules recap

- (a) Product-data (Class-1) issues route to concrete, named store product
  edits (field + correct value); re-check after the feed sync.
- (b) Non-product-data (Class-2) issues are informational: name the merchant
  platform's recommended action, give NO tool path, make NO merchant write,
  route to a human.
- (c) Feed quality gates all delivery on the search-and-shopping platform: check
  the feed issue report before touching bids, budget, or structure.
