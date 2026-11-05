---
name: brainstorming
description: The one interactive phase — settle the design with the owner at the rung's depth, ground every claim, elicit prerequisites last, and use a prototype or decision board where clicking beats prose.
phase: brainstorm
---

# Brainstorming

You run this phase yourself, in conversation with the owner. It is the only moment in the
flow where a question is legitimate, so everything that needs the owner is settled here.

When Frame's echo shows `ATELIER_AUTONOMY=autonomous` (a host runs the session unattended), follow atelier.md §0b instead: one line, assumptions in `brief.md`, no question.

## Depth by rung

- **R0**: no conversation unless the intent is genuinely ambiguous; then one line with your
  reading and a recommendation, and go.
- **R1**: as few exchanges as it takes: scope, risk, the fix you intend. If the owner already said
  what they want, confirm and go.
- **R2**: the conversation below, ending in an approved spec.
- **R3**: open with a research sweep (haiku or sonnet readers, one schema: claim, source,
  confidence, open question) and seed the first question from its open questions.
- **R4**: R2 plus a decision board (below) for the choices that fan out, and the multipart
  spec set follows in Spec. The roadmap phasing is discussed here too: what each phase
  proves, what it excludes, how it is validated.

## How to talk

- One question per turn, always with a recommendation and its rationale, alternatives with
  theirs. Have an opinion. Plain prose; the owner replies in chat.
- Present the design in short sections, each sized to one decision, and validate each before the next.
- Adapt to the owner's proficiency; they are experienced engineers who want cognitive load
  kept low. No jargon walls, no long breakdowns.
- Never ask what the codebase or the brief already answers. Confirm and extend your grounding
  against the real code; do not re-explore cold.
- YAGNI early: remove features before they take root in the design.

## The grounding rule

No unverified claim enters the design. An API or SDK reference is read at its source; a
numeric value carries a derivation, datasheet or measurement, or is marked TBD with criteria;
a compatibility claim cites or is marked assumed; an external library is checked to exist and
to have the assumed API. A design that depends on an API that works differently is a design
constraint, surfaced now.

## The verification sweep (R2 and above, before writing the spec)

Trace every data path from source to sink. Verify every interface on both sides. Stress every
boundary: empty, maximum, saturation, concurrent, unavailable, malformed. Audit every fallback
to the same depth as the primary. Check for orphans: everything defined is referenced. Make
every criterion measurable. For UI, every view has its states: empty, loading, error,
populated, overflow. Surface what the sweep catches before writing.

## Prototypes and the decision board

- **UI or visual work**: build a pixel-faithful prototype as a published artifact (the real
  fonts, the real dimensions, the candidate states side by side) and let the owner pick from
  it. Pin the approved version's URL and label in the spec. Six candidate animations picked
  from one live page beat six paragraphs.
- **R4, or any set of choices with real alternatives**: publish a decision board (`boards`
  skill, card kind `decision`): one card per choice, options with your recommendation and the
  evidence, the owner clicks. Read the choices back from the board's database into
  `decisions.md` as `D<n>` entries: decision, why, alternatives rejected, source. That log is
  append-only; a superseded decision gets a new entry, never an edit.

## Prerequisites: the last questions you get to ask

Walk the downstream phases (execute, validate, any deploy or publish the design implies) and
ask: does any of them need something only the owner can provide? A credential or secret, an
authenticated CLI (`gh`, `glab`, cloud login, `docker login`), a deploy or publish target, an
account or project id, a paid resource. Ask now. Record in the spec's **Prerequisites** what
it is, which phase needs it, where the value lives (env var, secret file path, pre-authed
CLI) and the check that confirms it is present. Never the value itself. An un-elicited
prerequisite becomes the one legitimate `failed` downstream.

## Approval gate

At R2 and above, the owner reads the spec (or brief) and approves it explicitly; revise until
they do. Then one `state.json` write: `awaiting:null`, phase done, next phase. Decisions live
in the artifact, never in `state.json`.
