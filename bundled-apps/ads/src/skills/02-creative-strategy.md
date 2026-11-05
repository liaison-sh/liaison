---
name: 02-creative-strategy
description: Creative doctrine; concept over format over hook, sequential testing at low volume
kind: playbook
requiredScopes: ["ads:campaigns:read"]
---

# Creative strategy

You are advising on what creatives to make, in what order to test them, and how to read the results. On modern broad-delivery platforms the creative IS the targeting: the ranking engine matches creative to user, so the lever you actually control is the diversity and quality of concepts you feed it, not audience knobs. This playbook tells you how to build and test creative without fooling yourself at low purchase volume.

## The testing hierarchy: concept, then format, then hook

RULE: Concept beats format beats hook. Test in that order.

There is a strict priority to what moves performance (stackmatix.com, admove.ai):

1. **Concept** (the angle / value proposition): the single biggest lever. A different reason-to-buy outperforms any amount of polishing on the same reason. Test concepts first.
2. **Format** (UGC, studio, testimonial, demo, catalog, static vs video): second-order. Which execution format best carries a winning concept.
3. **Hook** (the first 3 seconds of video, or the opening line / first frame of a static): third-order but high-leverage within a concept. A strong hook can roughly double CTR on an identical value proposition (segwise.ai, bir.ch). Hook has four elements: text overlay, sound, visual, vibe.

Do not skip to hook-tweaking or format-swapping while the concept is unproven. Optimizing hooks on a losing concept is polishing the wrong object. When you brief creative, brief concepts first: distinct reasons to buy, not headline variants.

Why this order: the ranking engine can only match a concept it has been given. Ten hooks on one concept are ten doors into the same room; five concepts are five different rooms. Concept diversity is what lets the engine find buyers across different reasons-to-buy, so it dominates. Format decides which execution best carries a proven room; hook decides how many people step through the door once the room is right.

### Angle taxonomy for concepts

When generating concepts, draw from the standard angle set (stackmatix.com):

- **Outcome lead**: the result the buyer gets ("play expressively in minutes").
- **Problem lead**: the pain the product removes.
- **Social-proof lead**: what other buyers / experts say.
- **Mechanism lead**: how it works, why it is different.
- **Comparison lead**: versus the status quo or an alternative.

A healthy prospecting campaign runs ~10-25 CONCEPTUALLY distinct creatives, meaning different value propositions and angles, mixed across formats (UGC, studio, testimonial, demo, catalog), NOT 20 variations of one headline (confect.io, jonloomer.com, marketingagent.blog). Twenty headline variants of one concept is one concept, not twenty.

## 3-3-3, adapted to low volume

RULE: At low purchase volume, run the 3-3-3 tests SEQUENTIALLY, not in parallel. Parallel splits fall below the significance floor.

The 3-3-3 framework (Pilothouse) is 3 concepts x 3 variations x 3 hooks; brands running it have reported meaningful outbound-CTR lift year over year (vendor case). The framework is sound, but the naive parallel version assumes you have enough events to power nine or twenty-seven simultaneous cells. Most small accounts do not.

The statistical floor to separate a creative winner from noise on purchase events is roughly 30-50 conversions per variant, spending at least ~1x AOV per concept tested (askneedle.com, zentric.digital). An account attributed only a couple dozen purchases per quarter cannot reach that floor on purchase events for even one variant, let alone nine in parallel. If you split a small budget nine ways, every cell is below the floor and every "winner" is noise.

So at low volume:

- Run the hierarchy **sequentially**. Test 3 concepts first (as diverse creatives inside one well-fed ad set). Take the directional winner. Then, in a later window, test formats of that concept. Then hooks. One decision at a time, each with its own decision date (see playbook 04).
- Test on **upper-funnel metrics** where thousands of events exist (CTR, cost per landing-page view, cost per initiate-checkout), treated as DIRECTIONAL signal only. Purchases validate only at month scale; a month below the purchase floor is INCONCLUSIVE, not a winner.
- Concentrate spend so at least the upper-funnel signal is stable, rather than spreading it so thin that nothing reads.

At mid and larger budgets you can widen toward parallel cells as volume allows, but the same rule holds: never run more cells than you have events to power.

### Sizing a test to the volume you actually have

Before proposing any creative test, sanity-check the arithmetic:

- **Purchase floor:** ~30-50 conversions per variant to read a purchase winner, and at least ~1x AOV of spend per concept. Multiply by the number of variants. If the account cannot produce that many purchase events in the window, you cannot test on purchases; drop to upper-funnel signal and say so.
- **Upper-funnel headroom:** landing-page views and initiate-checkout events run into the thousands even on small accounts, so an upper-funnel test can read in days. That is why it is the small-account default, always labeled directional.
- **Cells vs budget:** if splitting the budget across N cells leaves each cell below the readable-event floor for its chosen metric, reduce N (go sequential) rather than accept unreadable cells. An unreadable cell is worse than no test: it produces a confident-looking number that means nothing.

## Creative diversity is the targeting mechanism

RULE: On broad delivery, creative diversity IS the targeting mechanism. Feed the system diverse creative rather than segmenting audiences.

On modern ranking-engine platforms the retrieval stage matches each creative to the users it predicts will respond, so a diverse creative set effectively self-targets across many micro-audiences at once. This is why the small-budget structure is one broad ad set with many diverse creatives (playbook 01), not many narrow audiences with one creative each. Advantage-style audience settings are advisory; the system reaches outside them when it predicts better performance (jonloomer.com).

Practical consequence: when someone wants "more targeting," the answer on broad is usually "more diverse concepts," not "more audience segments." Diversity of angle, format, and hook gives the system more surfaces to match. Broad targeting has been observed to outperform lookalikes by a wide margin under the modern engine (Lebesgue aggregate via 1clickreport/confect.io; directional, not gospel) precisely because the creative carries the targeting.

## Never call a creative winner on CTR alone

RULE: Never declare a creative winner on CTR alone. CTR is an upper-funnel proxy.

CTR, thumb-stop, and cost-per-landing-page-view are useful DIRECTIONAL signals and are often the only metrics with enough volume to read at a small budget. But they are proxies, and a proxy is suspect until it demonstrably tracks purchases on THIS account. A creative can win on CTR and lose on purchases (clickbait hooks, mismatched audiences, wrong buyers). So:

- Use upper-funnel metrics to shortlist and to kill obvious losers, never to crown a purchase winner on their own.
- Before trusting a proxy, check whether high-CTR creatives on this account have historically also driven more purchases. If they have not, the proxy is lying and you must weight purchases more, even if that means waiting for month-scale volume.
- When you report a "winner," state the metric tier it won on and its confidence: "leading on CTR and cost-per-IC over two weeks, directional only, not yet validated on purchases." Do not present a directional signal as a settled result.

### The four hook elements

When you get to hook testing, vary one of these at a time (segwise.ai, bir.ch):

- **Text overlay**: the on-screen words in the first frame / first 3 seconds.
- **Sound**: opening audio, music, voice.
- **Visual**: the opening image or motion.
- **Vibe**: tone and pacing of the open.

A strong hook can roughly double CTR on an identical value proposition, which is exactly why you must not confuse a hook win (attention) with a concept win (buyers). Changing two hook elements at once makes the result unreadable; change one.

### Signal quality is a prerequisite for reading any creative test

A creative test can only be as good as the conversion signal underneath it. Pixel-only tracking loses roughly 20-40% of conversions to ad blockers and iOS ATT; server-side / CAPI recovers most and a typical advertiser sees a +10-25% effective-ROAS improvement, materializing over 2-4 weeks as the algorithm adapts (signalbridgedata.com, dataally.ai, digitalapplied.com; partly vendor-stated). Match quality (hashed email plus phone plus click ids) drives results more than raw event volume. Two consequences for creative testing:

- If the account's signal is pixel-only and lossy, purchase-based creative reads are even noisier than the sample math suggests; lean harder on upper-funnel signal and flag the measurement gap.
- When server-side tracking has just been turned on, expect a 2-4 week adaptation period; do not attribute a swing in that window to a creative change.

Note also that the platform has no refund event in its conversions API, so purchase counts you read do not net out refunds and returns; a considered-purchase category with meaningful returns will show slightly inflated purchase signal. Treat platform purchase counts as an upper bound, and prefer first-party revenue for the real picture (see playbook 04).

## Iteration cadence on a winner

Once a concept genuinely wins (validated, or at least strongly directional and sustained):

- Produce 3-5 variations changing ONE element at a time (one hook, one format, one visual), every ~2-3 weeks. Changing one element keeps each iteration readable.
- Document the concept, format, and hook of each winner as the brief for the next round, so the account compounds creative learning instead of restarting it.
- Keep refreshing before fatigue sets in (see playbook 06 on frequency); a winning concept decays as frequency climbs, so the pipeline of the-next-variation matters as much as the current winner.

### Creative fatigue and the refresh trigger

A concept does not win forever. As frequency climbs (roughly above 1.5-3.0 per the frequency guidance in playbook 06), CTR falls and CPMs rise: the same people are seeing the same creative too often. The refresh trigger is a rising frequency together with a decaying upper-funnel metric on a formerly strong creative. When you see it, do not tear down the campaign (that resets learning, playbook 01); instead introduce fresh variations of the winning concept into the same continuous ad set. The creative pipeline is therefore continuous, not a one-off test: you are always preparing the next variation so the account never runs a fatigued creative as its only prospecting asset.

## Metric tiers for reading a creative test

Creative evidence lives at three tiers, in ascending order of trust (see playbook 04 for the full measurement ladder):

1. **Upper-funnel** (CTR, thumb-stop, cost per landing-page view, cost per initiate-checkout): thousands of events even on a small account, readable in days. DIRECTIONAL only. Use to shortlist and to kill obvious losers.
2. **Purchase**: the truth, but scarce. ~30-50 conversions per variant to separate winner from noise. On a small account this validates only at month scale, if at all.
3. **Blended** (MER, revenue over spend across channels): the account-level efficiency check, not a per-creative signal, but the backstop that tells you whether the creative program as a whole is paying.

Before trusting an upper-funnel proxy on THIS account, verify it has historically tracked purchases here. If high-CTR creatives on this account did not also drive more purchases, the proxy is lying; weight purchases more heavily and wait for volume.

## Worked sequential test plan (small budget)

When asked how to test creative on a small account, propose something like this, adapted to the real regime read in playbook 01:

1. **Window 1 (concepts):** 3-5 conceptually distinct creatives (different angles from the taxonomy) inside the one broad ad set. Set a decision date. Read on cost-per-landing-page-view / cost-per-IC. Kill the clear losers; carry the directional leader.
2. **Window 2 (format):** take the leading concept, produce it in 2-3 formats (for example UGC vs studio vs demo). Same one broad ad set, sequential, new decision date.
3. **Window 3 (hook):** take the leading concept+format, vary the hook (text overlay, sound, visual, vibe). Sequential, new decision date.
4. **Validation:** let the surviving winner run at month scale and check purchases. If the month is below the purchase floor, report INCONCLUSIVE, not a win.
5. **Iterate:** on a real winner, spin 3-5 one-element variations every 2-3 weeks and document concept/format/hook as the next brief.

Never compress this into nine parallel cells at a small budget. Sequential is slower but it is the only version that produces readable signal when volume is scarce.

## Before you brief or judge creative, read these

- **Before choosing the delivery structure for a test**, read playbook 01: tests run inside one well-fed broad ad set at small budget, not across new ad sets.
- **Before deciding a winner**, read playbook 04: define the metric tier and minimum sample and decision date FIRST, and never call a winner before the decision date plus the minimum sample.
- **Before leaning on audience targeting instead of creative**, read playbook 03: on broad, creative diversity is the targeting lever.

## Creative reporting posture

When you report creative recommendations or results: name the concept/angle, name the format and hook, name the metric tier the evidence sits at, and state whether it is directional or validated. Recommend the next sequential test and its decision date. Do not present nine parallel cells at a small budget, do not crown a CTR winner as a purchase winner, and if you are asked to pick a winner from a test that never reached its sample floor, say it is inconclusive and say why. Any spend increase behind a test is gated: recommend it, do not execute it unprompted.

## Common creative failure modes to name

- **Twenty headlines, one concept**: a "test" that is really one angle in disguise. Recommend diverse concepts from the angle taxonomy instead.
- **Nine parallel cells on a small budget**: every cell below the readable floor. Recommend the sequential plan above.
- **Crowning a CTR winner**: a hook that wins attention but not buyers. Require purchase or blended validation before scaling.
- **Hook-tweaking a losing concept**: polishing the wrong object. Re-test the concept first.
- **Tearing down a fatigued campaign**: resets learning. Refresh creative inside the continuous campaign instead (playbook 01).
- **Reading a swing during CAPI adaptation**: attributing a 2-4 week signal-adaptation swing to a creative change. Wait out the window.

## Hard rules recap

1. **Concept beats format beats hook; test in that order.**
2. **At low volume, run 3-3-3 sequentially, not in parallel** (parallel splits below the significance floor).
3. **On broad, creative diversity IS the targeting mechanism**: feed diverse concepts rather than segmenting audiences.
4. **Never declare a creative winner on CTR alone**; CTR is an upper-funnel proxy, suspect until it demonstrably tracks purchases on this account.
