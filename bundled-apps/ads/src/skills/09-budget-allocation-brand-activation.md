---
name: 09-budget-allocation-brand-activation
description: Cross-platform budget allocation and brand vs activation balance at small budgets
kind: playbook
requiredScopes: ["ads:campaigns:read"]
---

# Budget allocation and brand/activation balance

Doctrine for splitting budget across platforms and between brand-building and
activation (direct-response). This playbook is platform-neutral: apply it to
whichever ad platforms are actually in the mix. Read the real spend first, state
the assumed budget regime (playbook 01) from the actual monthly figure, and only
then allocate. Never assume the budget; never propose a split without first
reading what is being spent and where.

## Read before you allocate

Before any allocation recommendation:
1. Read the account's actual monthly spend and how it is currently distributed
   across platforms and objectives (via the platform read tools).
2. Determine the budget regime (playbook 01: small <5k/mo, mid, larger).
3. State the regime explicitly, then apply the rules below scaled to that regime.

The strategic frames in this playbook come from brand-science research done at
large-brand scale. At a small budget they are DIRECTIONS, not literal splits.
Applying a big-brand ratio mechanically to a tiny budget is a common and
expensive mistake.

## Strategic frames: use as direction, not literal split

Hard rule (a): **treat the 95:5 and 60:40 frames as strategic FRAMES, not literal
splits at small budgets.**

- **95:5 (Ehrenberg-Bass):** at any given moment roughly 95% of category buyers
  are NOT in-market; performance/activation ads harvest the ~5% who are buying
  now, while brand building determines whose shortlist the other 95% carry when
  they eventually enter the market (marketingscience.info, John Dawes). The
  lesson is that most of your future buyers are not ready today, so pure
  bottom-funnel harvesting has a hard ceiling — it can only ever capture the
  current 5%.
- **60:40 (Binet & Field):** across long-run studies, roughly 60% brand-building
  to 40% activation is the effectiveness optimum for sustained growth; for B2B,
  brand-science evidence argues for an even more brand-weighted mix
  (mi-3.com.au, marketingarchitects.com).

Do NOT read these as "spend 60% of a 1.5k/mo budget on brand ads." At small
budgets a literal 60% brand split buys too little reach on any single channel to
build mental availability, while starving the activation that pays the bills. The
frames tell you which DIRECTION to lean and why continuity matters (rule b); they
do not set the arithmetic. Translate them into the small-budget actions below.

## Continuity beats bursts at small budgets

Hard rule (b): **at small budgets, continuity beats bursts.** The actionable
translation of the brand frames for a niche brand on a modest budget is:
always-on, modest, continuous spend beats seasonal blasts. Continuous presence is
how you build mental availability and category-entry-point associations you can
afford; it also protects the learning phase (playbook 01) that repeated on/off
campaign churn destroys. A pattern of many short-lived campaigns is a permanent
learning-phase reset and an anti-pattern (zombie/churn hygiene: playbook 06).

Practical small-budget allocation:
- Run a small number of consolidated, continuously-running campaigns (playbook
  01) rather than turning campaigns on and off by season.
- Carry the brand layer largely through organic and creator/earned content,
  which a small paid budget cannot fund at reach; let paid focus on activation
  plus the modest always-on presence that continuity requires. (Creator-borne
  credibility is amplified by paid, rarely created by it.)
- Where budget genuinely does not stretch to a real brand-building presence, say
  so honestly and lean the paid budget toward efficient activation while the
  brand layer rides on organic — do not pretend a tiny brand-ad line is building
  meaningful mental availability.

## Blended MER cannot justify cutting brand or continuity

Hard rule (c): **blended MER cannot by itself justify cutting brand or continuity
budget.** Blended marketing-efficiency ratio (total real revenue / total ad
spend across all channels) is the operating efficiency truth and outranks any
single platform's self-reported return — but it is a rear-view, DIRECTIONAL
efficiency ratio, not an incrementality measure. It cannot separate demand you
CREATED from demand you merely CAPTURED. Brand building and continuity mostly
create future demand; their payoff shows up later and diffusely, exactly where a
blended ratio is blind.

So when someone points at blended MER to argue for cutting brand or continuity
spend and reallocating everything to the highest-attributed activation channel:
refuse that inference. Cutting brand/continuity often flatters blended MER in the
short term (you stop paying for the slow-burn layer while still harvesting the
demand it already seeded) and erodes the demand pipeline underneath. This ties
directly to the always-on trust-hierarchy doctrine: MER is directional, not
incrementality; only a real incrementality test (a holdout, when volume permits —
playbook 04) can adjudicate whether brand/continuity spend is incremental, and at
small volume that test is usually underpowered, so structural judgment governs,
not the ratio.

Decision rule: never recommend cutting brand/continuity budget on the strength of
blended MER (or any platform ROAS) alone. Require an incrementality signal, or
state plainly that it cannot be measured at this volume and the decision is a
judgment call, not a data-driven one.

## Reach over frequency where budget allows

Hard rule (d): **prefer reach over frequency where budget allows.** Mental
availability is built by reaching MORE distinct category buyers, not by hitting
the same small audience repeatedly. Excessive frequency on a small audience wastes
budget and drives fatigue: keep frequency capped in the roughly 1.5-3.0 range;
above ~3 you get fatigue and rising CPMs, and should refresh creative or broaden
rather than keep paying to re-hit the same people (theoptimizer.io,
marketkingco.com). Where budget allows a choice, spend the marginal unit on
broader reach rather than higher frequency on an already-covered audience.

Caveat: this is "where budget allows." At the smallest budgets, retargeting a
warm, already-reached audience converts far more efficiently, so a portion of a
small budget still belongs on efficient activation/retargeting; the reach-over-
frequency rule governs the PROSPECTING/brand portion, not the retargeting portion.

## Cross-platform allocation

When more than one platform is in the mix:
- Do NOT compare platforms on their own self-reported return to decide the split
  — each platform claims the same orders and grades its own homework (always-on
  trust hierarchy; playbook 04). Use blended MER (DTC-split; see below) and
  structural judgment.
- Match platform to intent: a search-and-shopping platform harvests existing
  demand (high intent, closer to the 5%); a social/discovery platform creates and
  reaches demand (closer to the 95%). A healthy mix usually needs both a harvest
  channel and a demand-creation/reach channel; do not put the entire small budget
  on one and declare the other "worse" using unaudited platform numbers.
- Concentrate rather than fragment: at a small budget, spreading thinly across
  many platforms leaves every one below the volume it needs to exit learning and
  to measure anything (playbook 01). Fewer platforms, run continuously, beats many
  run thinly.

DTC/wholesale split: before drawing any allocation conclusion from revenue,
split out B2B/wholesale revenue from direct-to-consumer. B2B demand-sensing is
coarse and must never sit in a conversion feed; do not let wholesale revenue
inflate the blended MER you are using to allocate consumer ad budget. A B2B
order is recognised by the order itself, never by guessing from its skus: it is
placed for a B2B company, or it carries the store's B2B order tag (older orders
may instead carry a B2B sku suffix). `blended_mer_dtc` and `cpa_by_sku_class`
already apply this rule; quote them rather than re-splitting by sku.

## Interaction with other playbooks

- Regime definition and consolidation at small budgets: playbook 01.
- Learning-phase protection and continuity vs churn: playbook 01; zombie/churn
  hygiene: playbook 06.
- Blended MER, incrementality, holdouts, and metric honesty: playbook 04 and the
  always-on trust-hierarchy doctrine.
- The search-and-shopping platform's role in the mix: playbook 07.

## Hard rules recap

- (a) 95:5 (Ehrenberg-Bass) and 60:40 (Binet & Field) are strategic FRAMES, not
  literal splits at small budgets.
- (b) At small budgets, continuity (always-on modest spend) beats seasonal
  bursts.
- (c) Blended MER cannot by itself justify cutting brand/continuity budget (it is
  directional, not incrementality) — ties to the trust hierarchy.
- (d) Prefer reach over frequency where budget allows (cap frequency ~1.5-3.0;
  above ~3 refresh or broaden).
