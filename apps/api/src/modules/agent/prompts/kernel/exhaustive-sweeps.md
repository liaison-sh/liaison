---
name: exhaustive-sweeps
type: skill
description: Count-anchored loop to process EVERY item of a set to zero; honesty rules; dedup exception.
---

## Exhaustive Processing (Sweeps)

When asked to process **every** item in a set ("reply to every open ticket", "finish every unfinished task", "enrich all the dealer contacts"), your job is to drive the work-list **to zero**, not to handle a sample and stop.

**The count is your anchor.** Every list/search tool returns `totalCount`: a server-side count of ALL items matching your filter, not the size of the page you got back. Pass `countOnly: true` for a cheap count with no rows. Because `totalCount` is computed from the live predicate, it is always truthful and self-correcting: process one item, its state changes, it leaves the filter, and the next call's `totalCount` drops by one. **You cannot lose count.**

**The loop:**
1. List the pending set with the filter that defines "not done yet" (e.g. `status: "open"`, or `terminal: false`) and read `totalCount`.
2. Process a batch: each item inline, or **one `kernel__spawn_agent` per item** when isolation, untrusted content, or a narrower scope applies (see Sub-Agent Dispatch). Processing must flip the item OUT of the pending predicate (send the reply, move the task to a done status, write the enrichment).
3. Re-read the count (a fresh list / `countOnly`).
4. Repeat until `totalCount` is 0.

**Keep going until it's zero.** If you run out of step budget mid-sweep, that is fine: you will be re-invoked and the count tells you exactly what remains, so pick up where the predicate now stands. In a background routine the next tick resumes the same way. Do not stop early and call a partial pass "done".

**Show the countdown.** In an interactive chat, post progress as you go ("Processed 12 of 47, 35 to go…") so the user watches the work drain. End with the measured final count ("All 47 done").

**Honesty (unchanged, and easier now):** report the MEASURED `totalCount`, never a guessed or tallied number. If you stop before zero (budget, credits, an error, or the user's bound), say exactly how many remain ("38 of 47 done, 9 remaining"). Only when a tool genuinely cannot enumerate the whole set (a hard result cap with no cursor, or no count for that source) do you fall back to an explicitly-labelled bounded sample, and you say so.

**Idempotency.** Always act on the CURRENT pending set each pass; an item already processed has left the predicate, so re-running never double-acts. For a GATED send (reply/refund/email), the item stays "pending" until the human approves and it actually sends, so within one run, do not re-draft an item you have already queued this run.

**NOT every "do X to all of them" task is a drainable sweep: deduplication is the key exception, and it has a DEDICATED tool.** The linear-drain loop above does NOT apply to "find and merge every DUPLICATE in the list": there is no "is-a-duplicate" `totalCount`, and deciding whether two records are the same person is a PAIRWISE comparison (≈N² work). Do NOT try to do it with `kernel__contacts_search` (capped 50/page, ILIKE substring only, no fuzzy/normalized match) by paging and eyeballing names: that is guesswork and leads weak models to fabricate completeness. Instead, for a dedup / "merge all the duplicates" ask: (1) Call **`kernel__contacts_find_duplicates`**: it scans the WHOLE contact set server-side (normalized email, accent/abbreviation/typo-folded names, shared externalIds) and returns candidate duplicate CLUSTERS, each with a `confidence` tier ('high' / 'needs_confirmation'), the `signal` that connected them, and the member ids/names. This is the grounded list to act from. (2) Honesty: the scan is bounded, it returns `scannedCount`/`totalCount`/`coveragePartial`. If `coveragePartial` is true, you scanned only part of the list, so report that and do NOT claim you found EVERY duplicate; if it is false you may say you scanned the whole list. Never invent a number: report what the tool returned. (3) Because `kernel__contacts_merge` is IRREVERSIBLE, propose merges ONLY for the **high-confidence** clusters (more complete record as survivor: keep "Beatriz Carvalho", not "B. Carvalho"; and only ids you actually saw in the tool result). SURFACE, but do NOT auto-stage, every **needs_confirmation** cluster (e.g. a shared surname with a different given-name root like Michael vs Mikkel at the same company), and ask the user to confirm those are the same person before any merge. Merging two records that are actually different people destroys real data permanently.
