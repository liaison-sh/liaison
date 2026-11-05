---
name: 06-scaling-and-kill-rules
description: Scale +20%/72h, kill vs target CPA, frequency caps, and zombie campaign hygiene
kind: playbook
requiredScopes: ["ads:campaigns:read"]
---

# Scaling and kill rules

Codifiable media-buying operations: when to scale a winner, when to kill a loser, how to keep frequency and account hygiene under control. These are the rules that turn a working structure into more spend without breaking the learning system, and that cut waste without cutting things that were merely early.

Read this before you propose any budget increase, pause, or archive.

## Before you act

1. **Read the account's real state via tools first** (`account_info` + `insights_query`): current spend, the configured target CPA if one exists, delivery, frequency, and per-campaign status. Every threshold below is relative to the account's OWN targets and regime, not an absolute (see playbook `01` for the regime taxonomy).
2. **All spend increases are gated.** Propose the change and let the human approve it. Do not raise budgets unilaterally. State the assumed regime and the target the change is measured against so the human can approve on evidence.
3. **Consult open and recent experiments before scaling or killing** (Tier-1 experiment discipline). Do not kill an ad set that is mid-test before its decision date, and do not scale a change whose test result is still inconclusive (playbook `04` owns the decision-date and minimum-sample rules).

## Scaling winners

Scale slowly enough that the learning system keeps up. Fast budget jumps re-trigger the learning phase and throw away the efficiency you built.

- **The rule: +20% every 72 hours on a proven winner. Not faster.** The 72-hour cadence leaves a full attribution window between steps so each increase is judged on settled data, not on noise from the previous change. Expect an account to reach several times its original budget over roughly 90 days while holding ROAS within about 15% of baseline (roaspy.com, adamigo.ai).
- A "winner" is a structure that met its decision date and its minimum sample (playbook `04`), not one that merely looks good after two days. Do not scale on an unconfirmed or upper-funnel-only signal.
- If ROAS or blended MER drifts more than about 15% off baseline as you scale, pause the ramp and hold at the last good budget rather than pushing through the drift.
- Prefer scaling the winning consolidated campaign vertically (raise its budget) over cloning it into many new ad sets. Cloning fragments the learning system and scatters the budget below the significance floor (playbook `01` on consolidation).
- Judge scaling success on first-party revenue and blended MER, not on the platform's self-reported ROAS, which inflates (playbook `04`).

## Killing losers

Kill relative to the account's target CPA, not to a gut feeling and not to an invented number.

- **The rule: pause when CPA exceeds roughly 120% of the target CPA, after the ad set has spent at least about 1x AOV** (theoptimizer.io, scalemate.co). Spending less than 1x AOV before judging is too little data, and killing then is premature; you may be killing a structure that had not yet exited learning.
- A softer variant: if CPA sits above the threshold for two consecutive days, cut that ad set's budget by about 20% rather than killing outright, then re-read on the next window. This lets you de-risk without discarding the learning entirely.
- **If no target CPA is configured on the account, FLAG THE GAP. Do not guess a number.** A kill threshold cannot be set responsibly without a target CPA derived from margin and desired contribution. Tell the human the threshold cannot be set, ask for the target, and hold. Guessing a CPA target silently anchors the account's entire kill discipline to a made-up figure, which is worse than having no rule.
- **Budget floor sanity:** purchase optimization needs a weekly budget of roughly 50x the target CPA to exit learning reliably (get-ryze.ai). Below that floor, optimizing the purchase event directly is starved of conversions; optimize a cheaper, honestly-labeled upstream event instead and say so in the recommendation (this ties directly to the metric tiers in playbook `04`).

## Pause versus budget-cut versus archive

These are three different actions for three different situations; do not conflate them.

- **Pause** an ad set or ad when its CPA clearly breaches the kill threshold after adequate spend, or when it is fatigued past the frequency cap and you want to stop delivery while you prepare a fresh creative. A pause is reversible and preserves the structure.
- **Cut budget by about 20%** when the breach is marginal (for example CPA above the threshold for two consecutive days) and you want to de-risk without discarding the accumulated learning. Re-read on the next window and pause if it worsens.
- **Archive** a campaign that has no ongoing reason to exist: a finished launch, a closed season, or a zombie left ACTIVE for years. Archiving cleans up reporting and removes the risk of accidental re-funding into a cold learning phase.

Pick the lightest action that addresses the actual problem, and always state the target the action is measured against so the human can approve on evidence.

## Frequency caps

Frequency that climbs unchecked burns budget on fatigued audiences and drives CPMs up.

- Cap frequency around 1.5 to 3.0. Above 3.0 you are paying rising CPMs to re-show the same people the same creative, and returns fall (theoptimizer.io, marketkingco.com).
- When frequency approaches the cap, the fix is fresh creative or a broader audience, NOT a higher bid. Rotate the concept (playbook `02`) or widen targeting (playbook `03`). Raising the bid on a fatigued audience just pays more for the same declining response.
- A rising frequency paired with a falling CTR is the fatigue signature; treat that pair as a trigger to refresh, not to spend harder.

## Daily monitoring set

Read these each day and alert on meaningful swings:

- Spend pace, CPA, ROAS or blended MER, CTR, frequency.
- Alert on a day-over-day ROAS swing greater than about 15%, and investigate before reacting. A swing can be attribution noise, especially given the platform inflation and modeling covered in playbook `04`; do not kill or scale on a single noisy day.
- Watch spend pace against budget: an ad set that suddenly spends far faster or slower than its budget usually signals an auction shift or a delivery problem worth reading before acting.
- Pair CTR with frequency: rising frequency plus falling CTR is fatigue; falling CTR at flat frequency is usually a creative or audience-fit problem.

## Why the cadence matters

Every one of these rules exists to protect the delivery system's learning phase. The learning phase is the period during which the platform gathers enough conversions to optimize delivery; it needs settled data and a stable budget. Fast budget jumps, frequent structural edits, and constant new campaigns all reset it, and an account stuck in permanent learning never reaches the efficiency it is capable of. The +20% / 72h scale rule, the 1x-AOV spend gate before killing, and the zombie/churn hygiene are all the same principle in different clothes: give the system stable, settled data to learn from, and change it deliberately rather than reactively.

## Retargeting allocation on small budgets

Retargeting is the highest-efficiency spend on a small account, so protect its share when you scale or cut.

- Warm retargeting audiences convert several times higher and at a materially lower CPA than cold prospecting (get-ryze.ai, vendor-stated ranges). A meaningful slice of a small budget (roughly a quarter to 40%) belongs there.
- When you cut budget under the kill rules, cut from the weakest cold prospecting first, not from working retargeting, unless retargeting itself is the thing breaching the CPA threshold.
- Keep retargeting audiences consent-clean and correctly windowed (playbook `03` for consent, playbook `05` for window length on considered purchases). A cheap conversion against a non-consented audience is not a win; it is a compliance liability.

## Zombie hygiene

Old campaigns left ACTIVE quietly damage the account.

- **Hunt zombie ACTIVE campaigns** with no recent spend or delivery: campaigns left ACTIVE for years after their reason to exist ended (a launch that finished long ago, a season that closed). Archive them. They clutter reporting, confuse allocation reads, and, if accidentally re-funded, restart from a cold learning phase.
- Watch for the churn anti-pattern: an account that has cycled through dozens of short-lived campaigns is stuck in a permanent learning-phase reset, never accumulating the settled data the delivery system needs (playbook `01` on continuity over churn). The fix is to consolidate into a few durable campaigns rather than spinning up a new campaign per idea.
- Beware the cheap-reach trap when auditing awareness spend: an ultra-low-CPM buy that bought hundreds of thousands of impressions at a fraction of a currency unit CPM but produced a near-zero CTR and essentially no landing views is junk placement (low-quality inventory / broad audience-network style placements), not a win. Awareness objectives need placement discipline and a real brand-lift rationale, not CPM bragging rights. A near-zero CTR at a tiny CPM is a signal to cut, not to celebrate the cheap reach.

## Scaling paths: vertical versus horizontal

There are two ways to spend more, and at a small budget one is far safer.

- **Vertical (raise the budget on the winning campaign).** This is the default. It keeps the learning the campaign already accumulated and follows the +20% / 72h cadence. It is the safe path at low volume because it does not fragment the budget.
- **Horizontal (clone the winner into new ad sets or audiences).** This scatters the budget across new cells that each restart in learning and each fall below the significance floor. Avoid it at a small budget. Only reach for horizontal scaling once volume is high enough that new cells can each clear their own learning phase, which a small account rarely can.

When asked to "scale," default to vertical and say why. Reserve horizontal expansion for genuinely new, tested structures funded from the roughly 10-20% testing slice, not as a way to spend a winner's budget faster.

## A worked kill/scale decision

When you evaluate a campaign, walk this order:

1. Is it mid-test before its decision date? If yes, leave it; do not touch it (playbook `04`).
2. Is a target CPA configured? If no, flag the gap and stop; you cannot judge kill/scale responsibly yet.
3. Has it spent at least about 1x AOV? If no, keep gathering data.
4. Is CPA above roughly 120% of target after that spend? If yes, propose a pause (or a 20% budget cut if it is a two-day breach). If no and it is a confirmed winner, propose +20% and set the next review 72 hours out.
5. Is frequency above 3.0? If yes, propose fresh creative or a broader audience regardless of the CPA read.

## Common questions the doctrine answers

- "This campaign is crushing it, can we double the budget today?" No. Scale at +20% every 72 hours. A budget doubling re-triggers the learning phase and discards the efficiency you built.
- "CPA looks high, should I kill it?" Only after it has spent at least about 1x AOV and only relative to the target CPA (pause above roughly 120% of target). If it has spent less than 1x AOV, it may not have exited learning; keep gathering data.
- "There is no target CPA set, what threshold do I use?" None. Flag the gap and ask the human for a target CPA derived from margin and desired contribution. Do not guess a number.
- "Frequency is at 4, should I raise the bid to keep delivery?" No. Above 3.0 the audience is fatiguing; refresh the creative or broaden the audience. A higher bid just pays more for a declining response.
- "There is an old campaign still ACTIVE from a launch two years ago, leave it?" No. Archive it. Zombie ACTIVE campaigns clutter reporting and restart cold if re-funded.
- "This awareness buy got 450k impressions at a tiny CPM, is that a win?" No, if the CTR is near zero and it drove essentially no landing views. That is junk placement, not reach worth having.

## Hard rules

1. **Scale winners at +20% every 72 hours, not faster.** A faster ramp re-triggers the learning phase; hold or back off if ROAS/MER drifts more than about 15% from baseline.
2. **Kill relative to target CPA** (pause when CPA exceeds roughly 120% of target after spending at least about 1x AOV). **If no target CPA is configured, FLAG the gap and ask for one; do not guess a number.**
3. **Cap frequency** around 1.5 to 3.0; above 3.0, fix with fresh creative or a broader audience, never a higher bid.
4. **Hunt zombie ACTIVE campaigns** with no spend or delivery and archive them; avoid the campaign-churn anti-pattern that keeps the account in a permanent learning-phase reset.

## When the account lacks the inputs to decide

Several rules here depend on inputs that may not be configured. Handle the gaps honestly rather than inventing values:

- **No target CPA:** flag it and ask for one; do not guess. This is the single most important gap, because it silently defines all kill discipline.
- **No reliable AOV:** the "spend at least about 1x AOV before judging" gate needs a real AOV. If it is unknown, read it from first-party order data where possible; if you cannot, say the gate cannot be applied precisely and err toward gathering more data before killing.
- **No first-party revenue read:** if you cannot confirm efficiency against first-party revenue, treat platform ROAS as unaudited (playbook `04`) and scale conservatively, stating the limitation.

In every case, the correct move is to surface the missing input to the human, not to substitute a plausible-looking number that quietly becomes the account's operating truth.

## An account-hygiene audit checklist

When asked to review an account's operational health, walk this list and report each finding:

1. **Zombie campaigns:** any ACTIVE campaign with no recent spend or delivery. Recommend archiving.
2. **Churn pattern:** a history of many short-lived campaigns. Recommend consolidating into durable structures (playbook `01`).
3. **Frequency:** any ad set above 3.0. Recommend fresh creative or a broader audience.
4. **Kill threshold configured:** is a target CPA set. If not, flag the gap and ask for one.
5. **Budget floor:** is weekly budget at least roughly 50x the target CPA for purchase optimization. If not, recommend optimizing a cheaper labeled event.
6. **Cheap-reach junk:** any awareness buy with near-zero CTR at a tiny CPM and no landing views. Recommend cutting or fixing placement discipline.
7. **Scaling posture:** are winners being scaled vertically at +20% / 72h, or jumped and cloned. Recommend the disciplined cadence.

Report findings with the specific campaigns or ad sets involved and the target each is measured against, then let the human approve the gated changes.

## Why absolutes are dangerous here

Every threshold in this playbook is relative to the account's own targets and regime. A CPA that is a disaster for one account is healthy for another with different margin. A budget that is generous for one account starves another with a higher target CPA. Always read the account's real figures first and state the regime, then apply these rules as ratios against the account's own targets, never as universal absolute numbers. When the account lacks a target to measure against, the correct output is to surface that gap, not to import a number from elsewhere.

## Sources

Scaling cadence and expected ramp: roaspy.com, adamigo.ai. Kill thresholds and the two-day budget-cut variant: theoptimizer.io, scalemate.co. Purchase-optimization budget floor (roughly 50x target CPA weekly): get-ryze.ai. Frequency caps: theoptimizer.io, marketkingco.com. Retargeting efficiency and cheap-reach observations are vendor-stated or account-observed and used as directional context only.
