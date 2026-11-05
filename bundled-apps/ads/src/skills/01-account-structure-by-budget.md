---
name: 01-account-structure-by-budget
description: Structure ad accounts by budget regime; consolidate at small budgets, protect learning
kind: playbook
requiredScopes: ["ads:campaigns:read"]
---

# Account structure by budget regime

You are advising on how to lay out campaigns, ad sets, and budget across an ad account. The single most common failure mode in small and mid accounts is a structure copied from a large-account playbook: too many campaigns, too many ad sets, too little volume per unit, permanent learning-phase churn. This playbook tells you how to size the structure to the actual budget you read from the account.

## Read the regime before you advise anything

RULE: State the assumed budget regime BEFORE giving structural advice, and derive it from real spend, never from a guess.

Do this every time, at the start:

1. Read the account's actual monthly spend via tools. Use `account_info` for account currency and status, and `insights_query` over the trailing 30 days (or trailing 90 divided by 3) at the account or campaign level to get real monthly spend in the account currency. Amounts come back in minor units (cents) for most currencies; convert before reasoning.
2. Classify into a regime from the real figure:
   - **Small budget: under ~5k/month.** Volume is the binding constraint. Almost every recommendation on this account is about not fragmenting scarce spend.
   - **Mid budget: ~5k to ~30k/month.** Some room for parallel structure, but the learning system still rewards consolidation. Test deliberately, not sprawlingly.
   - **Larger budget: above ~30k/month.** Enough volume that separate campaigns per objective/audience can each exit the learning phase; classic segmented structures start to earn their keep.
3. Say the regime out loud in your answer: "At roughly X/month you are in the small-budget regime, so ..." If you could not read spend, say you could not read it and ask, or read it, before advising. Never assume a budget.

These thresholds are directional, in the account currency, and about spend PER OBJECTIVE per platform, not total company marketing. A brand spending 6k split across three platforms is a small-budget account on each of them.

### How to read spend correctly

A few traps when reading spend via tools:

- **Minor units.** Most currencies report spend in minor units (cents). 149900 is 1,499.00 in the account currency, not 149,900. Convert before you classify, or you will mis-regime by two orders of magnitude.
- **Window choice.** Use a trailing 30 days for a stable current picture, or trailing 90 divided by 3 to smooth a spiky account. Do not read a single peak week and extrapolate; a seasonal blast week is not the account's regime.
- **Per objective, per platform.** Sum spend within an objective on a single platform, not across the whole account. Regime is a per-arm property.
- **Active-but-not-spending units.** Some campaigns are ACTIVE yet deliver nothing; exclude them from the live-spend picture and flag them as zombie hygiene candidates (playbook 06).

If `insights_query` returns nothing for the window, the account may be paused or brand-new; say so rather than treating zero as small-budget noise.

## Small-budget doctrine (the default you will meet most often)

RULE: At under ~5k/month, run 1-2 consolidated campaigns per platform. Do NOT fragment.

The learning system needs volume flowing through few units to find the pattern. Fragmenting a small budget across many campaigns and ad sets gives every unit too few events to ever exit learning, so the whole account optimizes on noise.

Concretely, at a small budget:

- One broad prospecting campaign per platform, one ad set, many conceptually distinct creatives inside it. On the social platform, creative diversity is the targeting lever, not audience splits (see playbook 02 and 03). A controlled test saw a single ad set with ~25 diverse creatives beat a five-ad-set structure by roughly +17% conversions at -16% cost (Five Nine Strategy, via confect.io/marketingagent.blog; treat as directional).
- Optionally one retargeting campaign if warm-audience volume justifies it. Retargeting can take ~25-40% of a small budget and converts several times higher at a lower CPA (get-ryze.ai; vendor-stated ranges), but only run it if the warm pool is large enough to leave the learning phase.
- That is usually the whole account. Resist the urge to add "just one more test campaign" that starves everything.

If the account cannot afford enough purchase events for purchase optimization (weekly budget below ~50x the target CPA is the rough floor, get-ryze.ai), optimize a cheaper, honestly-labeled upstream event (landing-page view, initiate-checkout) rather than a purchase event that never accumulates signal. Say explicitly that you are doing this and why.

## Brand vs non-brand split on the search platform

RULE: On the search platform, always separate brand from non-brand.

Brand and non-brand queries have different intent, economics, and reporting truth. Keep them in separate campaigns for budget, strategy, and reporting (storegrowers.com, jumpfly.com). Two failure modes to guard against:

- A blended campaign lets cheap brand clicks flatter the account's average CPA and hide expensive, unprofitable non-brand spend.
- Performance Max cannibalizes brand terms unless brand is excluded with account-level negatives or via a rep (see playbook 07). Left unmanaged, PMax quietly claims credit for brand demand you would have captured for free.

This split holds at every budget. At a small budget it may mean the entire search allocation goes to a handful of highest-intent non-brand commercial keywords plus a thin brand campaign, nothing else.

## Protect the learning phase

RULE: Do not edit inside the learning phase, and do not stack many low-volume ad sets that can never exit it.

The learning phase is when the delivery system is still gathering events to stabilize optimization. Two disciplines:

- **Do not make significant edits while an ad set is learning.** Budget changes, targeting changes, creative swaps, and objective changes reset learning. Batch changes, make them deliberately, then let the unit re-stabilize. When you scale, use the +20% / 72h cadence in playbook 06 precisely so each step does not blow up learning.
- **Do not stack low-volume ad sets.** Each ad set needs its own event throughput to exit learning. Ten ad sets at a small budget each sit permanently in learning-limited purgatory. Consolidate into fewer, better-fed units. This is the structural reason small budgets consolidate.

When someone asks "should I split this into more ad sets to test X," the default answer at small/mid budget is no: test through creative diversity inside one well-fed ad set, or run tests sequentially (playbook 02), not through structural fragmentation.

## Continuity beats seasonal on/off churn

RULE: Campaign continuity beats seasonal on/off churn. A recurring pattern of dozens of short-lived campaigns is an anti-pattern.

Every time a campaign is torn down and a new one spun up, learning resets and the account pays the learning tax again. An account history of many short-lived campaigns (for example dozens of campaigns each run for a few weeks then abandoned) means the delivery system was permanently re-learning and never compounding. This is one of the most expensive silent mistakes a small account makes.

Prefer:

- **Always-on modest spend** over seasonal blasts. Continuity lets the system compound learning and keeps mental availability warm between peaks (see playbook 09 on brand vs activation).
- **Refreshing creative inside a continuous campaign** over tearing the campaign down. New creatives inside a living, well-fed campaign keep the learning while fighting fatigue.
- **A stable spine of 1-2 evergreen campaigns per platform**, with tests layered as new creatives or occasional short structured experiments, not as a rotating cast of whole new campaigns.

When you see a churn pattern in the account's history, name it as an anti-pattern and recommend consolidating into a continuous structure, not because a burst is never right, but because at small volume the learning tax on constant churn dwarfs any seasonal upside.

### Why churn is so expensive at small volume

The learning tax is fixed per unit: every fresh campaign or ad set must re-accumulate events before it optimizes well. At a large budget that tax is paid quickly and amortized over lots of spend. At a small budget the same tax is paid slowly (few events per day) and amortized over almost nothing, so a churning small account can spend most of its life in the learning phase and never reach the stable, well-optimized state that makes advertising pay. That is why "always-on and boring" beats "a fresh exciting campaign every few weeks" for a small account: continuity is the only way scarce volume ever compounds.

Testing budget still has a place. Allocate roughly 10-20% of budget to testing new structures alongside the proven spine (pixelflow.so), but as layered tests inside or beside the continuous campaigns, not as a rolling replacement of the whole account.

## Consolidation checklist (what "good" looks like)

Before recommending any structure, verify:

- Regime stated, derived from real spend read via tools.
- Few campaigns, few ad sets: enough volume per unit to exit the learning phase.
- One broad prospecting unit per platform; creative diversity carries the testing load.
- Brand and non-brand separated on the search platform.
- No edits pending inside a learning unit; changes batched.
- A continuous spine, not a churn of short-lived campaigns.
- Any spend increase is gated: recommend it, do not execute it unprompted.

## Regime decision table

Use this as the quick reference once you have read real monthly spend per objective per platform. All figures are in the account currency and are directional, not hard cutoffs; when spend sits near a boundary, prefer the more conservative (more-consolidated) regime.

| Real spend / month / platform | Regime | Campaigns per platform | Ad sets | Testing mechanism | Optimization event |
|---|---|---|---|---|---|
| under ~5k | small | 1 prospecting (+1 retargeting if warm pool is large enough) | 1 broad prospecting | sequential creative tests inside the broad ad set | purchase if weekly budget >= ~50x target CPA, else a cheaper honestly-labeled upstream event |
| ~5k to ~30k | mid | 1-2 prospecting + retargeting | few, each well-fed | mostly sequential, widen toward parallel only as volume allows | purchase, if the ~50x-CPA weekly floor is met |
| above ~30k | larger | segmented per objective/audience as each can exit learning | multiple, each above the learning floor | parallel cells allowed where each is powered | purchase |

When the account spans multiple platforms, classify EACH platform independently on its own per-platform spend. A company at 9k total split three ways is small-budget on each platform, not mid-budget.

## Before you touch structure, read these

- **Before recommending audience segmentation**, read playbook 03 (audience doctrine): at small/mid budget the answer to "more targeting" is broad plus diverse creative, not more ad sets.
- **Before recommending a creative test structure**, read playbook 02: tests run sequentially at low volume, so the structure must not fragment to accommodate parallel cells.
- **Before recommending scaling or kill actions**, read playbook 06: the +20% / 72h cadence and the kill-relative-to-target-CPA rule are what let you change a structure without resetting learning.
- **Before advising on the search platform's structure**, read playbook 07 (brand/non-brand separation, PMax feed-first, negatives governance).

## Worked example: sizing an unfamiliar account

Someone asks "how should we structure our account?" and you know nothing about the budget yet. Do this:

1. Call `account_info` (currency, status) and `insights_query` over trailing 30 days at campaign level.
2. Convert from minor units. Suppose the platform in question totals ~2,100 in the account currency for the month.
3. Classify: under ~5k -> small-budget regime.
4. State it: "You are at roughly 2.1k/month on this platform, which is the small-budget regime, so the structure should consolidate rather than fragment."
5. Recommend: one broad prospecting campaign, one broad ad set, 10-25 conceptually distinct creatives; one retargeting campaign only if the warm pool is large enough to leave learning; keep both always-on; protect learning by batching edits; no interest-stack backbone.
6. Check for anti-patterns in the current account: many starved ad sets, zombie ACTIVE campaigns, a churn pattern, blended brand/non-brand on search. Name each you find and give the consolidation fix.
7. Note any gated action (a budget increase) as a recommendation for the human-approved path, and flag a missing target CPA / target ROAS if none is configured.

## Common anti-patterns to name when you see them

- **Fragmentation at a small budget**: many campaigns/ad sets each starved below the learning floor. Recommend consolidation to 1-2 units per platform.
- **Zombie ACTIVE campaigns**: ancient campaigns left ACTIVE but not delivering, cluttering the account and confusing reporting. Recommend archiving them (see playbook 06 zombie hygiene).
- **Churn**: a recurring pattern of dozens of short-lived campaigns spun up and torn down, resetting learning every cycle. Recommend a continuous evergreen spine with creative refreshes instead.
- **Blended brand/non-brand on search**: cheap brand clicks masking unprofitable non-brand spend. Recommend the split.
- **Interest-stack / manual CBO-vs-ABO backbone**: legacy structure predating broad delivery. Recommend consolidating to broad plus creative diversity.

## Reporting posture

When you report structure recommendations, tie the advice to the regime and the real figure you read. "You are at ~2k/month, which is small-budget: consolidate to one broad campaign plus one retargeting campaign, protect learning, keep it always-on." A recommendation that does not name the regime, or that assumes a budget you did not read, is incomplete. If a target CPA or target ROAS is not configured on the account, flag that gap rather than inventing a number to reason from. Remember that every spend increase is gated: you recommend it and leave the execution to the gated, human-approved path, never raising budget unprompted.

## Hard rules recap

1. **State the assumed regime before advising**, derived from real spend read via tools, never assumed.
2. **At under ~5k/month, run 1-2 consolidated campaigns per platform; do not fragment.**
3. **Separate brand from non-brand on the search platform.**
4. **Protect the learning phase**: do not edit inside it, do not stack many low-volume ad sets.
5. **Continuity beats seasonal on/off churn**: a pattern of dozens of short-lived campaigns is an anti-pattern; run an always-on evergreen spine.
