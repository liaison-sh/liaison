---
name: 04-testing-and-measurement
description: Test design, metric tiers, decision dates, and why platform attribution lies
kind: playbook
requiredScopes: ["ads:campaigns:read"]
---

# Testing and measurement

Doctrine for designing honest experiments and reading their results at a small budget. This playbook governs HOW you decide whether a change worked. It is the guardrail against the single most expensive mistake in performance advertising: believing a number that a dashboard reports without asking whether the number can be believed.

Read this before you propose, launch, judge, or scale any test.

## Before you design anything

1. **Read the account's real state via tools first.** Call `account_info` for the account and `insights_query` for recent spend and purchase volume. The entire test design depends on which budget/volume regime you are in. Never assume the budget and never assume the purchase count.
2. **State the regime out loud** once you have read it (see playbook `01` for the regime taxonomy). A test that is sound at scale is unsound at a few hundred currency units per week, and the difference decides whether significance is even reachable.
3. **Consult open and recent experiments before proposing a new one.** The Tier-1 experiment-discipline rule requires it. Do not launch a test that duplicates a live one, and do not launch a change that resets a structure still inside its learning phase or still mid-test before its decision date.
4. **Record the test before you launch it:** the hypothesis, the single variable, the metric tier, the minimum sample, and the decision date. An unrecorded test cannot be honestly judged later because you will have forgotten what you were actually testing.

## The core problem: self-graded homework

The platforms grade their own homework. A platform's reported ROAS is an unaudited claim built from its own attribution model, and every platform claims the same orders under its own model. You cannot trust a number simply because a dashboard shows it in a confident color. Your job is to design tests whose result you can actually believe, and to say plainly when the account cannot support a believable test rather than manufacturing a false one.

## Metric tiers

Classify every metric you might optimize on or judge by into one of three tiers. State the tier explicitly before launching, because the tier decides how much data you need and how much you are allowed to conclude.

### upper_funnel

Impressions, reach, frequency, CTR, cost per landing-page view, cost per initiate-checkout. These fire in the thousands even on small budgets, so they reach significance quickly. But they are PROXIES for the thing you care about. A proxy is suspect until it demonstrably tracks purchases for THIS account, not for advertising in general. Use upper-funnel metrics as directional signal only. They are never a standalone win criterion, and you never scale on them alone.

Concretely: a creative can win on CTR and lose on purchases, because CTR measures whether the thumb stopped, not whether the wallet opened. Treat an upper-funnel improvement as a hypothesis worth confirming at the purchase tier, not as a proven result.

### purchase

The purchase event itself and cost per purchase. This is the metric that actually matters, but at low volume it is starved of data. The statistical floor to separate a winner from noise is roughly 30-50 conversions per variant (askneedle.com, zentric.digital), and a rough spend floor of about 1x AOV per concept tested. An account attributing only about 15-25 purchases per quarter cannot hit that floor on a purchase-optimized split test inside any reasonable window. Acknowledge that up front instead of pretending a two-week purchase split means something.

### blended

Blended MER, defined as total real revenue across all channels divided by total ad spend, including untrackable channels. This is the operating truth for efficiency because it is computed from first-party revenue, not from platform claims. But it is a rear-view directional ratio, NOT an incrementality measure: it cannot separate demand you created from demand you merely captured. It outranks platform ROAS whenever the two disagree; it does not by itself justify cutting continuity or brand budget (see playbook `09`).

### Trust hierarchy for judging

Deterministic first-party revenue (order data, blended MER) outranks platform-reported conversions. Platform click-through purchase counts outrank platform view-through counts. When two of these disagree, believe the higher one and label the lower one as an unaudited platform claim.

In practice this means:

- When the platform reports strong ROAS but blended MER is flat, believe the flat MER. The platform is likely claiming orders it did not cause (view-through) or modeling orders it could not observe (iOS ATT loss).
- When a purchase value on the platform looks implausibly high for the product, treat it as a signal-quality artifact until first-party revenue confirms it, and say so in the recommendation.
- Never let a single platform number, however confident the dashboard looks, override a first-party read. The whole point of the hierarchy is that confidence of presentation is not evidence of truth.

## Experiment design procedure

1. **Define the metric tier and the minimum sample BEFORE launching.** Write down which tier you will judge on and the sample that tier requires (roughly 30-50 conversions per variant for purchase-tier; thousands of events for upper-funnel). If the account cannot reach the purchase-tier floor in a sensible window, decide NOW to run an upper-funnel-directional test instead, and label it honestly as directional rather than dressing it as a purchase test.
2. **Isolate one variable.** A test that changes creative and audience and budget at once teaches you nothing, because you cannot attribute the result. Change one thing; hold the rest constant.
3. **Set a decision date.** Every test gets a fixed calendar date on which you will read the result and decide. Do not peek and call it early. Do not let it drift indefinitely because the numbers look promising.
4. **Do not declare a winner before the decision date AND the minimum sample are both met.** If the decision date arrives and the sample floor was not reached, the result is INCONCLUSIVE. Report it as inconclusive. A month of purchases below the minimum-sample floor validates nothing. Only a human override may call a result early, and only with the incompleteness stated plainly in the recommendation.
5. **Prefer fewer, longer, consolidated tests.** Splitting a small budget across many simultaneous variants pushes every cell below the significance floor and pushes each ad set deeper into a permanent learning phase. One well-powered comparison beats five underpowered ones. When forced to choose between the illusion of a statistical winner and honest structural judgment, choose structural judgment.

## Sequencing at low spend

At low volume you cannot run parallel purchase-optimized splits and expect significance. Instead:

- Run tests SEQUENTIALLY. Test one change, read it against its decision date, then test the next. This concentrates spend so each test at least approaches its floor rather than starving several cells at once.
- Judge sequential tests on upper-funnel signal as a directional read, then confirm at month scale on purchases when volume allows. Never scale on upper-funnel signal alone.
- Consolidate audiences and creatives into as few cells as the test question allows (see playbook `01` on consolidation and `02` on running the 3-3-3 framework sequentially rather than in parallel at low volume).
- Reserve a modest slice of budget (roughly 10-20%) for testing new structures alongside the proven one, so you are always learning without betting the account on an unproven idea.

## Why platform attribution lies, and by how much

Treat every platform conversion number as inflated until proven otherwise.

- **View-through inflation:** platforms credit purchases to ads a user merely saw and did not click, inflating reported conversions by roughly 2-3x (measurement-science consensus across lifesight.io, segmentstream.com).
- **iOS ATT signal loss:** roughly 15-30% of conversion signal is lost to App Tracking Transparency and redistributed by the platform's modeling, so a chunk of reported conversions are modeled estimates, not observed events (signalbridgedata.com, digitalapplied.com).
- **Cross-platform double-counting:** never sum or compare conversions across platforms; each platform claims the same orders under its own model.
- **Server-side recovery is real but slow and vendor-stated:** moving to server-side conversions typically recovers signal and lifts effective ROAS by a vendor-stated roughly +10-25% over 2-4 weeks as the algorithm adapts (signalbridgedata.com, dataally.ai; treat as vendor-stated, not as a win criterion).

Because of all this, blended MER and holdout experiments OUTRANK platform-reported ROAS whenever they disagree. When you cite a platform ROAS figure in a recommendation, label it as platform-reported and unaudited so the human weighs it correctly.

## Geo-holdouts and incrementality

A geo-holdout (turn ads off in matched regions, compare the on regions against the off regions) is the cleanest small-account path to real incrementality. But it needs statistical power the account may not have.

- A properly powered geo-holdout or lift test needs an 80%-power design, a 4-8 week window, and matched regions each carrying enough conversions (lifesight.io, incrmntal.com, segmentstream.com).
- Below roughly a few hundred conversions per month, these experiments are underpowered and will return noise dressed as a result. If the account is below that floor, SAY SO HONESTLY: recommend blended MER as the operating truth and defer the holdout until volume supports it. Do not run an underpowered holdout and present its output as an incrementality finding. That is the exact self-delusion this playbook exists to prevent.
- MMM (media mix modeling) is even further out of reach: Robyn and Meridian both need 2+ years of varied spend data, and MMM is irrelevant below roughly 50k per month of spend. Do not propose it for a small account.

### The measurement ladder by maturity

Think of measurement as a ladder you climb only as far as your volume and history allow. Trying to stand on a rung the account cannot reach produces false confidence, which is worse than honest uncertainty.

1. **Blended MER** (bottom rung, always available). Total real revenue across all channels, including untrackable ones, divided by total ad spend. Directional efficiency, not incrementality. This is the operating truth for a small account.
2. **Incrementality experiments** (middle rung, needs volume). Geo-holdouts and lift tests with 80%-power designs over 4-8 week windows and matched regions. Reachable only above roughly a few hundred conversions per month.
3. **MMM** (top rung, needs history and scale). Robyn (ridge regression, simpler, small-business-friendly) or Meridian (Bayesian, geo-level, reach and frequency aware). Needs 2+ years of varied spend and is irrelevant below roughly 50k per month of spend.

State which rung the account can honestly stand on, and do not borrow conclusions from a rung above it.

## What to write in a recommendation

When you report a test result or a measurement read, always include: the metric tier judged on, whether the minimum sample was met, whether the decision date was reached, and an explicit note of anything that CANNOT be measured honestly at this volume. Documenting the limits of measurement is part of the job, not an admission of failure.

## Worked example: a creative test at low volume

Suppose the account attributes about 20 purchases per quarter and you want to test a new creative concept.

1. Read spend and purchase volume via tools. Confirm you are at low volume and state the regime.
2. Recognize that a purchase-tier split test cannot reach the 30-50-conversions-per-variant floor in weeks; a two-variant purchase split would need many months.
3. Decide to test the new concept SEQUENTIALLY against the incumbent, judged on an upper-funnel tier (cost per landing-page view and cost per initiate-checkout, which fire in the hundreds or thousands), explicitly labeled directional.
4. Set a decision date (say two weeks) and the minimum sample for the upper-funnel metric.
5. On the decision date, read the result. If the new concept clearly beats the incumbent on the directional metric, you have a hypothesis, not a proven purchase winner. Do NOT scale on it alone. Run the winner longer to see whether the directional edge shows up in purchases at month scale, and only then treat it as confirmed.
6. If the directional metric is inconclusive at the decision date, report it as inconclusive and move to the next sequential test rather than extending indefinitely.

## A test-readiness checklist

Before launching any test, confirm every item:

1. You read the account's real spend and purchase volume via tools and stated the regime.
2. You checked open and recent experiments; this test does not duplicate a live one or reset a learning phase.
3. You recorded the hypothesis and the single variable under test.
4. You named the metric tier (upper_funnel / purchase / blended) and its minimum sample.
5. You confirmed the account can plausibly reach that sample in the window; if not, you relabeled the test as upper-funnel-directional.
6. You set a fixed decision date.
7. You confirmed the signal feeding the test is complete and well-matched (no leaky pixel, dedup intact, consent in order).

If any item is unmet, do not launch; fix the gap or redesign the test honestly.

## Common questions the doctrine answers

- "The dashboard shows 5x ROAS, can we scale?" Not on that number alone. Platform ROAS is unaudited and inflates; confirm against blended MER from first-party revenue before scaling, and honor the +20% / 72h cadence in playbook `06`.
- "This creative has double the CTR, is it the winner?" No. CTR is an upper-funnel proxy. It is a directional signal worth confirming at the purchase tier, never a standalone win.
- "Can we run a geo-holdout to prove incrementality?" Only if the account clears roughly a few hundred conversions per month with an 80%-power, 4-8 week design over matched regions. Below that, say so and use blended MER as the operating truth.
- "We got 8 purchases this month, did the change work?" Inconclusive. That is below the sample floor; report it as inconclusive, not as a win or a loss.

## Hard rules

1. **Define the metric tier and the minimum sample BEFORE launching a test.** State which of upper_funnel / purchase / blended you will judge on, and the sample that tier requires.
2. **At low volume, purchase-optimized tests will not reach significance; upper-funnel metrics are DIRECTIONAL signal only, never a standalone win criterion.** Any proxy is suspect until it demonstrably tracks purchases for this account. Never scale on upper-funnel signal alone.
3. **Set a decision date and do not call a winner before the decision date AND the minimum sample are both met.** A result below the sample floor at the decision date is INCONCLUSIVE, not a win. Only a human override calls it early, and the incompleteness must be stated.
4. **Platform attribution is self-graded and inflates** (view-through roughly 2-3x, iOS ATT roughly 15-30% signal loss); blended MER and holdouts OUTRANK platform-reported ROAS. Never compare or sum conversions across platforms.
5. **Geo-holdouts need power the account may not have** (80%-power, 4-8 week window, matched regions, a few hundred conversions per month); if the account is below that floor, say so honestly and fall back to blended MER rather than running an underpowered test.

## Signal quality feeds measurement honesty

The quality of the conversion signal the platform receives sets a ceiling on how trustworthy any measurement can be, so treat signal quality as part of measurement, not a separate concern.

- **Pixel-only tracking loses conversions.** Client-side pixels miss roughly 20-40% of conversions to ad blockers and iOS ATT (signalbridgedata.com, digitalapplied.com). A test judged on pixel-only data is judged on a partial, biased sample.
- **Server-side conversions recover most of that signal**, typically lifting effective ROAS by a vendor-stated roughly +10-25% over 2-4 weeks as the algorithm adapts (signalbridgedata.com, dataally.ai). Marked vendor-stated; do not treat the recovered lift as a test win, it is a signal-quality change, not a performance change.
- **Match quality matters more than raw event volume.** Sending strong identifiers (hashed email, phone, click ids) drives results more than sending more events with weak matching.
- **Deduplication is a contract.** Browser and server events must pair on a shared key so the same order is not double-counted. A broken dedup setup silently inflates reported conversions and corrupts every downstream measurement.

When you read a result, ask first whether the signal feeding it is complete and well-matched. A confident number built on a leaky, poorly-matched pixel is not evidence.

## Consent is a measurement precondition too

In the EEA, conversion modeling depends on client-side consent signals. If consent is suppressed and no client signal is sent, the conversion is not modeled, it is simply lost. So a drop in reported conversions can reflect a consent or tagging problem rather than a real performance drop. Rule out signal and consent issues before concluding that a change hurt performance. This ties to the GDPR floor: no audience upload without recorded, purpose-appropriate consent (playbook `03`).

## Sources

Statistical floor and spend-per-concept: askneedle.com, zentric.digital. Attribution inflation and iOS signal loss: signalbridgedata.com, digitalapplied.com, lifesight.io, segmentstream.com. Server-side ROAS recovery (roughly +10-25%, vendor-stated): signalbridgedata.com, dataally.ai. Incrementality / holdout power and MMM thresholds (Robyn, Meridian): lifesight.io, incrmntal.com, segmentstream.com.
