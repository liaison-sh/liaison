---
name: author-routine
type: skill
description: Author, schedule or automate a routine: weekly, nightly, cron, event, stale ticket auto close.
---

### Authoring a routine

"Draft, propose, set up, schedule or automate" a recurring or event-driven job means CALLING `kernel__create_routine` (or `kernel__update_routine`) once you have looked up its scopes (below); a prose description of the routine is not the proposal. The routine-authoring tools are gated: calling `kernel__create_routine` with the concrete config (`kind`, `cron` or `event`, `prompt`, `scopes[]`) is how you submit the routine for approval. The platform creates the pending routine-approval card a human reviews and activates, and only then does `kernel__list_routines` show it active. So `kernel__tool_search` for `kernel__create_routine`, call it with the finalized config, then report the routine as pending approval. Never describe the routine in prose and end your turn with an "approve this routine here" link without calling the tool: that link points at a card that was never created, and the task is unfinished. Have every input you need (the URLs or keys, the cron, the framing)? Then make the call; do not stop to ask for a config you can already supply, the scopes included (below). If one required input is genuinely missing (a URL the user never gave), still author the routine with the parts you have and name the one missing field.

### Look up the scopes, then create in the same turn

A routine gets exactly the `scopes[]` you pass: nothing is added from the words of its prompt. Work them out, then create (or widen with `kernel__update_routine`) in one go:

1. List the tools the routine's prompt will call on each tick (for example `mail__search`, `mail__reply`).
2. Call `kernel__routine_tool_scopes` with those tool names. It returns the scope each tool needs, in words, and whether the user holds it.
3. Call `kernel__create_routine` with that list right away. Do not ask the user to confirm the scopes in the chat first: the call files ONE approval card that says in plain words what the routine will read and change, and approving that card is the user's confirmation.
4. Tell the user the routine is waiting for their approval on that card (cite its `approvalHandle`), and in a sentence what it will read and change. Only say a card is waiting when the tool result says `pending_approval`; if the call failed, say it failed and why. A scope they do not hold is left out of the routine and filed as a scope request: say so rather than promising it.

A hand-off to another agent with `kernel__agents_ask` needs `kernel:threads:read` and `kernel:threads:write`. Posting the routine's own result needs no scope. The owner can also change the scopes later in the routine's editor (Edit > Scopes).

### A routine that drafts a gated customer message or close

A routine whose per-tick prompt drafts a gated customer message (a final-notice `tickets:reply` or `tickets:nudge`, an acknowledgement, a dunning `mail:reply`), or a gated `tickets:close`, never auto-sends or auto-closes: a routine cannot self-approve its own gated calls, so every gated call its tick makes lands as its own per-tick approval in the routine's output thread for the owner to review. The message and the close each get their own approval. When you author such a routine, frame BOTH the gated message AND the gated close as per-tick approvals; do not describe only the close as gated while implying the message goes out automatically (`tickets:nudge` is gated exactly like `tickets:reply`). A "send a final notice and close, but let me approve the closes" ask is fully satisfied by a routine whose tick proposes a gated final-notice message and a gated close per stale ticket, both pending the human; say so plainly.

### Stale-customer discrimination belongs to the server

For a "no customer reply for N days" or stale auto-close routine, bake the server-side staleness test into the prompt: `tickets:search` with `status: 'awaiting_customer'` and `silentForDays: N` returns each row's `customerSilent` boolean (true means silent for N days or more). The tick acts on exactly the `customerSilent: true` rows and skips the fresh ones. It copies the per-row boolean; it never judges the last-inbound age itself, which is the fragile in-context arithmetic that wrongly nudges a customer who just replied.
