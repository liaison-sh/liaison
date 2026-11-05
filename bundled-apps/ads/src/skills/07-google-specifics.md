---
name: 07-google-specifics
description: Search-platform doctrine, feed-first PMax, brand/non-brand split, negative-keyword governance
kind: playbook
requiredScopes: ["ads:campaigns:read"]
---

# Search-platform specifics

Doctrine for the search-and-shopping ad platform (Search, Shopping, and the
consolidated performance product that mixes shopping, search, display, and video
inventory from a single feed plus asset groups). This playbook ships as doctrine
now; the tools for this platform arrive in a later phase. Until they do, apply
these rules when advising, and phrase every read as coming from "the search
platform's <report>" — do NOT invent tool names that do not yet exist in your
toolset. When the tools land, the decision rules here are unchanged.

Before advising on this platform, read the actual account first: current spend,
which campaign types are running, and whether a product feed is connected. State
the assumed budget regime from the real figure (see playbook 01) before making
any structural recommendation. Never assume the budget.

## Feed-first: the feed multiplies everything

For product-led ecommerce the product feed is the single highest-leverage lever
on this platform. Feed completeness and quality gate every downstream result.

Hard rule (a): **the consolidated performance product is feed-first — feed
quality multiplies everything.** "Perfect smart bidding on a 60% complete feed
loses to defaults on a 99% complete feed" (apexdigital.ro, groas.com). A
feed-only configuration (no uploaded creative assets) runs 30-45% lower cost per
sale for product-led ecommerce, because it avoids being pushed into pure-awareness
placements; add creative assets only after you have a feed-driven baseline
(storegrowers.com, digitalapplied.com). So: never try to fix a
feed-quality problem with bid strategy, budget, or creative. Fix the feed first.
The mechanics of diagnosing feed problems are in playbook 08 (merchant feed
health); this playbook covers the campaign structure that sits on top of a
healthy feed.

Decision rule: if a feed-driven campaign is underperforming, check feed health
(playbook 08) BEFORE touching bids, budget, or asset groups. A partial feed
caps the ceiling no matter what you do above it.

## Brand versus non-brand: always separate

Hard rule (b): **separate brand from non-brand.** Keep branded search (people
typing your name) in its own campaign, separate from non-brand generic search,
for budget, strategy, and reporting. Branded search is cheap, high-intent, and
mostly harvesting demand you already created; non-brand is expensive prospecting.
Blending them lets cheap branded conversions flatter the blended cost per
acquisition and hide non-brand inefficiency.

The consolidated performance product cannibalizes brand terms unless you exclude
them: it will happily spend on your own name and claim credit for conversions
that branded search (or organic) would have captured for far less. Set
brand-term exclusions at the account level (or via the platform rep where the
self-serve UI does not expose them) so the performance product prospects new
demand rather than re-buying your existing demand (storegrowers.com).

Decision rule: if branded and non-brand are in one campaign, or if the
performance product is uncapped on brand terms, flag it. Report the branded
cost per acquisition and the non-brand cost per acquisition SEPARATELY; never
report only the blended figure, which is a misleading average (ties to the
trust-hierarchy doctrine: a blended ratio hides the mix).

## Negative-keyword governance: deliberate, never bulk-blind

Hard rule (c): **govern negative keywords deliberately — bulk negatives silently
suppress delivery.** Negative keywords are how you stop spending on irrelevant
queries, but a careless bulk-negative list (especially broad-match negatives, or
a shared list applied account-wide) can silently block queries you actually want,
and the platform gives no loud warning: delivery just quietly drops. A broad
negative can also block near-variants, plurals, and misspellings you did not
intend.

Governance rules:
- Prefer exact and phrase negatives over broad negatives; a broad negative
  blocks a whole neighborhood of queries.
- Before applying a shared/account-wide negative list, check what converting
  queries it would block. Never apply a large negative list blind.
- Keep a record of why each significant negative was added, so a later reviewer
  can tell an intentional block from an accidental one.
- If delivery drops after a negative-list change, suspect the list first.

Decision rule: never bulk-add negatives without first confirming they do not
overlap converting search terms from the search-terms report.

## Search-terms mining: the continuous hygiene loop

Hard rule (d): **mine the search-terms report continuously.** The search-terms
report shows the actual queries that triggered your ads (as opposed to the
keywords you bid on). It is the ongoing hygiene loop of this platform: harvest
converting queries into their own keywords/asset groups, and negative out the
waste (playbook rule c). This is a recurring cadence, not a one-time setup.

The loop, run on a regular cadence:
1. Read the search platform's search-terms report for the period.
2. Find queries that converted (or show strong intent) but are not yet explicit
   keywords -> promote them.
3. Find queries that spent with no intent/conversion -> add as deliberate
   negatives (rule c: exact/phrase, recorded).
4. Watch for brand-term leakage into non-brand or into the performance product
   (rule b).

At a small budget this matters MORE, not less: a small budget cannot afford to
waste spend on irrelevant queries, and the search-terms report is the cheapest,
highest-signal place to cut waste. At very small budgets on this platform
(roughly <=500-1000/mo), concentrate on 5-10 highest-intent commercial keywords
with exact/phrase focus; broad testing is unaffordable (digitenzy.com, jyll.ca).

## Structure and bidding notes (apply after feed + brand split)

These support the hard rules above; they are not additional hard rules.

- Structure: 3-7 asset groups for the consolidated performance product; the
  platform has expanded search themes substantially, so use themes to steer
  asset groups rather than over-fragmenting (storegrowers.com).
- Bidding ladder: run maximize-conversions / maximize-conversion-value WITHOUT
  targets for the first 2-3 weeks so the platform gathers data, THEN constrain
  with a target cost per acquisition or target return once there is enough
  conversion history (jumpfly.com, modernmarketinginstitute.com). Setting a hard
  target on day one starves a cold campaign of learning data.
- Responsive assets: provide the full complement of headlines and descriptions
  (up to 15 headlines / 5 descriptions per responsive search ad); more quality
  assets give the platform more combinations to assemble (jumpfly.com). This is
  asset breadth, not creative testing — creative testing doctrine is playbook 02.
- Statistical honesty still applies: at low purchase volume, conversion-based
  optimization and targets will be noisy. Treat click-through and cost-per-click
  movements as directional only, set decision dates, and do not declare a keyword
  or asset-group "winner" on upper-funnel signal alone (see playbook 04).

## Interaction with other playbooks

- Feed diagnosis and repair: playbook 08 (merchant feed health).
- Budget regime and whether this platform belongs in the mix at the current
  budget: playbook 01 (account structure) and playbook 09 (budget allocation).
- Metric tiers, minimum samples, and decision dates: playbook 04.
- Trust hierarchy for cross-platform numbers (never compare this platform's
  reported conversions against another platform's — each claims the same orders):
  see the always-on doctrine and playbook 04.

## Hard rules recap

- (a) The consolidated performance product is feed-first: feed quality
  multiplies everything. Fix the feed before bids/budget/creative.
- (b) Separate brand from non-brand for budget, strategy, and reporting; exclude
  brand terms from the performance product; report the two cost-per-acquisition
  figures separately.
- (c) Govern negative keywords deliberately: bulk/broad negatives silently
  suppress delivery. Prefer exact/phrase, check overlap first, record intent.
- (d) Mine the search-terms report continuously: promote converters, negative
  out waste, watch for brand leakage.
