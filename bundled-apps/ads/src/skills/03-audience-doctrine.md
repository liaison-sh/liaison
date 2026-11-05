---
name: 03-audience-doctrine
description: Audience doctrine; broad-first, consent-clean seeds, lookalikes secondary
kind: playbook
requiredScopes: ["ads:campaigns:read"]
---

# Audience doctrine

You are advising on how to target: broad versus lookalikes versus interest stacks, what a seed audience may legally contain, and how long an audience needs before it can deliver. On modern broad-delivery platforms the audience layer has shrunk in importance while the creative layer has grown (see playbook 02). This playbook fixes the defaults and the compliance floor.

## Broad-first

RULE: Broad-first on the social platform. Broad beats lookalikes under the modern ranking engine.

The ranking engine matches creative to user at enormous scale, so a broad target plus a diverse creative set lets the system find buyers you would never have hand-picked. Broad has been observed to outperform lookalikes by a wide margin under the modern engine (Lebesgue aggregate via 1clickreport/confect.io; treat as directional, not gospel). The structural consequence is the small-budget default in playbook 01: ONE broad ad set per objective, many diverse creatives, consolidation over fragmentation.

So the default recommendation on the social platform is:

- **Start broad.** One broad prospecting ad set per objective. Let creative diversity do the targeting (playbook 02).
- **Do not pre-segment** the prospecting audience into many interest or lookalike ad sets at a small budget. That fragments volume and starves the learning phase (playbook 01).
- Treat Advantage-style audience suggestions as advisory: the system reaches outside any audience you set when it predicts better performance (jonloomer.com), so narrow settings mostly cost you reach without buying you control.

When someone asks for "better targeting," the answer on broad is usually more diverse creative, not narrower audiences.

### Why broad beats hand-picked audiences now

Before the modern engine, the advertiser's audience settings were the primary control: you picked interests and lookalikes and the system delivered inside them. Now the retrieval stage evaluates candidate ads at enormous scale and predicts, per user, who will respond to a given creative. A hand-picked audience mostly caps the pool the engine can search, discarding buyers it would have found. Broad plus diverse creative hands the engine the widest search space and the richest set of signals (the creatives themselves) to match on. This is the same reason the small-budget structure consolidates into one broad ad set (playbook 01): the value has moved from the audience layer to the creative layer.

## Seed audiences must be consent-clean

RULE: A seed audience (custom-audience upload) must be consent-clean. No upload without recorded, purpose-appropriate consent. This is the GDPR floor.

A custom-audience upload is data sharing with an ad platform and, in the EEA, requires informed, specific consent for exactly that purpose. A newsletter opt-in that never mentioned ad-platform sharing does NOT cover an audience upload (usercentrics.com, carlgottlieb.com, advalyze.com). Before recommending or building any uploaded seed audience:

- Confirm the source list carries recorded consent that specifically covers sharing with ad platforms for advertising. If it does not, do not upload it. Say why, and recommend a consented collection path instead.
- On the search platform's Customer Match in the EEA, each record must carry granted consent for ad_user_data and ad_personalization; unconsented records are simply not processed (support.google.com). Consent Mode v2 is mandatory for EEA ad personalization and modeling.
- **Erasure must be honored.** Audience membership has to be revocable via the platform's remove-user APIs. Event hashes already transferred sit under the platform's own retention; document that boundary rather than claiming you can retract them.

If you cannot confirm consent, treat the upload as blocked, not as a judgment call. This rule outranks any performance argument for using a richer seed. When you surface the recommendation to a person, avoid dash-style punctuation in the customer-facing wording; write it as plain sentences.

### What "consent-appropriate" actually requires

Signal quality and consent intersect. In the EEA, Consent Mode v2 sends ad_storage, ad_user_data, and ad_personalization signals from the client tag; those signals drive conversion modeling, and a suppressed server send without matching client consent signals is a lost, unmodeled conversion, not a recovered one. So the consented path is also the higher-quality-signal path: consent is not merely a legal tax, it is what keeps modeling working. When you recommend a collection path for a future compliant audience, recommend one that captures explicit ad-platform-sharing consent up front, so the same records can seed audiences AND feed conversion modeling.

## Lookalikes are secondary, interest stacks are legacy

RULE: Lookalikes are a secondary tool; interest stacks are legacy doctrine. Do not lead with either.

- **Lookalikes**: useful as a secondary layer once broad is established and there is a strong, consent-clean seed (purchasers, high-value customers). They are not the primary prospecting engine under the modern engine, and they inherit the consent status of their seed: a lookalike built from a non-consented upload is itself non-compliant. Add lookalikes after broad is working and volume allows a second ad set to exit learning, not before.
- **Interest stacks / detailed-interest targeting**: legacy tactics from the pre-broad era, along with manual CBO-vs-ABO gymnastics. They still exist but are largely obsolete doctrine; do not build a small account around stacked interests. If an account's history shows a structure built on interest stacks and manual bid/budget micromanagement, name it as legacy and recommend consolidating to broad plus creative diversity.

Ordering, from default to last resort: broad prospecting first; retargeting of warm consented pools; then, if volume allows, lookalikes from a consent-clean seed; interest stacks only for a specific, justified reason, not as the backbone.

### The consent status travels with the audience

Consent is a property of the DATA, so it follows the audience everywhere it is derived:

- A lookalike built from a non-consented seed is non-compliant, because the seed's records were shared without cover.
- A retargeting pool built from site visitors depends on the site's consent banner and Consent Mode signals; where those are missing in the EEA, the pool is thinner and partly unusable, not fuller.
- Duplicating a compliant audience is fine; enriching it with an unconsented list re-contaminates it.

So the consent check is not a one-time gate on the raw upload; re-run it whenever an audience is derived from another.

## A fresh audience must populate before it can deliver

RULE: A fresh audience must populate before it can deliver. Do not judge it, edit it, or kill it before it has filled and left the learning phase.

Custom audiences, lookalikes, and retargeting pools need time and matching to populate to a deliverable size; an audience that has not filled cannot deliver efficiently and its early numbers are meaningless. So:

- After creating or uploading an audience, let it populate before launching against it, and let the ad set gather events before reading it. Judging a fresh audience on day-one delivery is judging noise.
- Do not stack many fresh low-volume audiences at once; each needs its own throughput to exit the learning phase, and a small budget cannot feed several (playbook 01).
- Match quality matters more than raw size for uploaded seeds: hashed email plus phone plus click ids produce a better-matched, better-populating audience than a larger, thinner list. Higher match quality drives results more than event volume alone.
- Retargeting pools only work when the warm pool is genuinely large enough to leave learning; if it is not, fold retargeting spend back into the broad prospecting spine rather than running a starved retargeting ad set.

### Match quality: what makes an uploaded audience actually work

When an upload IS consented and you proceed, its effectiveness turns on match quality, not list length. Provide as many strong identifiers per record as consent covers: hashed email, phone, and click ids together match far more reliably than email alone, so the audience populates larger and the resulting lookalike is built on a cleaner seed. A short, high-match, fully-consented list beats a long, thin, partly-consented one on every axis that matters: legality, populated size, and downstream lookalike quality. When you recommend an upload, recommend maximizing identifier coverage within the consent you have, not padding the list.

## Consent decision procedure (run before any upload)

Before recommending or building ANY uploaded seed or lookalike, walk this in order and stop at the first failure:

1. **Source of the list?** If it is a newsletter opt-in, a purchase list, or any collection whose consent language did not specifically mention sharing with ad platforms for advertising, treat it as NOT covered. A generic opt-in does not cover an audience upload.
2. **Recorded, purpose-appropriate consent per record?** For EEA records, the platform requires granted consent for ad_user_data and ad_personalization; unconsented records are not processed. If you cannot confirm per-record consent, the upload is blocked.
3. **Erasure honored?** Confirm membership is revocable via the platform's remove-user API. Note that event hashes already transferred sit under the platform's own retention and cannot be retracted by you; document that boundary.
4. **Only if 1-3 pass**, proceed, and prefer high match quality (hashed email plus phone plus click ids) over raw list size.

If any step fails, mark the upload BLOCKED and recommend a consented collection path instead. This procedure outranks any performance argument. In customer-facing wording, write it as plain sentences without dash-style punctuation.

## Retargeting: when it earns a place, and when it does not

Retargeting warm, consented pools converts several times higher at a lower CPA (get-ryze.ai; vendor-stated ranges) and can take ~25-40% of a small budget when it is justified. But it is not free structure. Before recommending a retargeting ad set, check:

- **Pool size**: is the warm pool large enough to leave the learning phase and deliver steadily? A starved retargeting ad set sits in learning-limited purgatory and wastes structure. If it is too small, fold the spend back into the broad prospecting spine (playbook 01).
- **Consent of the pool**: site-visitor pools depend on the consent banner and Consent Mode; email-derived pools depend on ad-platform-sharing consent. Run the consent procedure below.
- **Window match**: for considered purchases with long decision cycles, the retargeting window must match the real cycle length, not a default 7 days (see playbook 05).

Retargeting is a strong secondary lever, never the prospecting engine; broad plus creative is still the backbone.

## Audience priority ladder

From default to last resort:

1. **Broad prospecting** carried by diverse creative. The backbone (playbook 02).
2. **Retargeting** of warm, consented pools, only if the pool is large enough to leave the learning phase; otherwise fold the spend back into broad.
3. **Lookalikes** from a consent-clean seed, secondary, only once broad works and volume allows a second ad set to exit learning. A lookalike inherits its seed's consent status.
4. **Interest stacks** only for a specific justified reason, never as the backbone; treat as legacy.

## Reading a fresh audience's early numbers

A newly created custom audience, lookalike, or retargeting pool goes through two settling periods before its numbers mean anything: it must first POPULATE (match and fill to a deliverable size), then its ad set must exit the LEARNING phase (accumulate enough events to optimize). Judging it before both are done is judging noise. Concretely:

- On day one, expect thin or erratic delivery; that is the audience filling, not the audience failing.
- Do not edit or kill the ad set inside its learning phase; that resets it (playbook 01). Batch any change and let it re-stabilize.
- A tiny fresh audience that never reaches deliverable size will never leave learning; if the pool is structurally too small, that is a reason not to run it, not a reason to keep waiting.
- Only after populate + learning are complete are the audience's cost and conversion numbers decision-grade.

State this explicitly when you recommend a new audience: "give it time to populate and exit learning before we read it; early numbers are not decision-grade."

## Before you recommend an audience, read these

- **Before segmenting**, read playbook 01: at small/mid budget consolidation beats fragmentation, so extra audiences usually starve learning.
- **Before proposing "more targeting"**, read playbook 02: on broad, more diverse creative is the targeting lever, not more audiences.
- **Before uploading anything**, run the consent decision procedure above; the GDPR floor is non-negotiable and outranks performance.

## Audience reporting posture

When you report audience recommendations: lead with broad, justify any lookalike or interest layer as secondary and volume-permitting, and for ANY uploaded seed state the consent status explicitly. If consent cannot be confirmed, mark the upload blocked. If an audience is fresh, say it must populate first and that early numbers are not yet decision-grade. Tie the structure back to the regime read in playbook 01: at a small budget the honest recommendation is usually broad plus creative diversity and a single consented retargeting pool, nothing more. Any spend behind a new audience is gated: recommend it, do not execute it unprompted.

## Worked example: an audience request on a small account

Someone asks "should we build a lookalike from our newsletter list to improve targeting?" Walk it:

1. **Regime**: read spend (playbook 01). If small-budget, a second prospecting audience will likely starve the learning phase, so the default answer already leans no.
2. **Consent**: the newsletter opt-in almost certainly did not mention ad-platform sharing. Run the consent procedure; step 1 fails, so the upload is BLOCKED and any lookalike from it inherits the block.
3. **Better move**: keep broad prospecting, add diverse creative (playbook 02), and if a retargeting pool is large and consented, run that instead.
4. **Compliant path forward**: recommend capturing explicit ad-platform-sharing consent going forward so a future seed is usable for both audiences and conversion modeling.
5. **Report**: state the consent status explicitly, mark the requested upload blocked, and recommend the broad-plus-creative alternative. Note any spend change is gated.

## Common audience failure modes to name

- **Uploading an unconsented list**: a legal and modeling failure. Block it, recommend a consented path.
- **Leading with lookalikes or interest stacks**: legacy backbone. Recommend broad-first.
- **A starved retargeting ad set**: too small to leave learning. Fold spend back into broad.
- **Judging a fresh audience on day one**: reading noise. Let it populate first.
- **A 7-day retargeting window on a weeks-long decision cycle**: mismatched. Match the window to the cycle (playbook 05).

## Hard rules recap

1. **Broad-first on the social platform**: broad beats lookalikes under the modern ranking engine.
2. **Seed audiences must be consent-clean**: no upload without recorded, purpose-appropriate consent (the GDPR floor).
3. **Lookalikes are secondary; interest stacks are legacy.** Do not build a small account around either.
4. **A fresh audience must populate before it can deliver**: do not judge, edit, or kill it before it has filled and left the learning phase.
