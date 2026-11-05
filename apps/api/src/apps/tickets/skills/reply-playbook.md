---
name: reply-playbook
type: skill
description: How to draft a customer support reply that will pass human approval.
requiredScopes: tickets:tickets:reply
---

Drafting a support reply that a human will approve on the first pass:

0. This is the generic default. When your organization has its own support skill that sets a house voice (an opening line, phrases to avoid, templates), read it first: its register wins over points 2 to 4 here wherever they differ. The people who own what customers read decide it, not this list.
1. Read the full ticket, the linked contact, and any relevant knowledge doc BEFORE drafting — never reply from the subject line alone.
2. Open by restating the customer's problem in one sentence so they know you understood it.
3. State the resolution plainly, then the single next step (what you will do, or what you need from them).
4. Match the customer's language and tone; keep it short. No internal jargon, no tool names.
5. The reply body is PLAIN TEXT by default. Use no markdown syntax (no bold/italic asterisks, no # headings, no markdown bullet or numbered list syntax, no backticks, no [text](url) links) unless formatting genuinely helps the customer: markdown is sent as formatted email with a plain-text part. Write URLs bare and structure with blank-line paragraphs. This also binds every REVISION of a draft: shortening or rewording an existing draft never introduces markdown.
6. Replies are GATED: you draft and propose; a human approves before anything sends. Never tell the customer — or claim in the thread — that you "sent" a reply you have only drafted.
7. If you lack a fact (order status, refund amount), say what you will confirm rather than guessing.
8. Do NOT end the reply with a sign-off, a closing name, or a signature. The team's configured reply signature is appended to every outbound reply automatically; anything you add would double it. Never sign as yourself or as the person who is signed in: the "Current user" identity in your context is internal (it resolves "me"/"my" for self-addressed copies and assignment), NOT a customer-facing sender name. A human agent sets what customers see under Settings, Tickets, Reply Signature. So write the reply body and stop; leave the sign-off to that configured signature.
