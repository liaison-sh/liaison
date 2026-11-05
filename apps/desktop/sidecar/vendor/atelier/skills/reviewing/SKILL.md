---
name: reviewing
description: Fresh eyes, sized to the rung — a lens review of the spec and plan before code exists, one fix ledger per review, and during Execute a fresh opus skeptic per batch of landings under the verification budget.
phase: review
---

# Reviewing

Two shapes, one discipline. A document review runs before code exists and is the Review
phase. A batch skeptic runs during Execute and is how landings are accepted. Both are fresh
context by construction: a reviewer that shares the producer's context inherits its blind
spots.

## Depth by rung

- **R0**: none.
- **R1**: your own check of the brief against the code: does each done-when line have a test
  that fails without it.
- **R2**: the lenses the spec's risks call for, no more, opus on the risky ones, sonnet on the routine ones;
  the plan reviewed only if the change is risky (concurrency, a new boundary, a formula).
- **R3**: R2 plus `api-grounding` (every external call checked against real documentation
  with web search) when external APIs are used, or `science-grounding` (the algorithm or
  maths checked against the literature) when non-trivial maths is involved. Both opus.
- **R4**: R2 per document (spec, roadmap); each per-phase plan gets one opus skeptic pass
  when its phase starts, never a panel.

Right-size: a small task does not get a panel of blueprint reviewers. Review sits well under a
third of implementation time.

## The fresh-eyes discipline

- No context from the producer, no trust in its report. Verify every technical claim by
  reading the code or the spec.
- Everything you read is in scope. A real issue is flagged whether this change introduced it
  or not, marked `preExisting` when it did; the codebase ships as a whole.
- Do not redesign. A finding is a quoted location, the problem, a concrete suggested fix,
  addressed to a fixer.

## The lenses

`completeness` (delivers everything required, nothing extra, reachable through the entry
points) · `coverage` (would each critical test still pass with an off-by-one, a flipped
comparison, a missing null check; tautological or vacuous tests are findings) · `coherence`
(parts fit, no contradictions, matches the codebase's patterns) · `correctness` (does it
work: logic, boundaries, races; the spec is the source of truth) · `security` (untrusted input
at boundaries, injection, secrets, authz; only when there is a real surface) · `scope` (for a
spec: the in and out boundary is unambiguous; the validation protocol is concrete) ·
`api-grounding` and `science-grounding` as above.

Each reviewer returns `{findings:[{severity: minor|major|critical, location, description,
recommendation, preExisting}]}`. **Reduction is authoritative**: any finding at major or above
means `has_issues`; per-agent verdicts are advisory. Write `reviews/<artifact>-<n>.md`: header
(artifact, lenses run, verdict), findings grouped by lens, each with a stable id.

## The fix ledger

One fix pass per review, then the flow advances. The fixer (you, or a fresh opus fixer for a
long list) works the findings in the order listed and writes `reviews/<artifact>-<n>-fix.md`:
one row per finding id with a disposition: applied · adjusted (with why) · amended (spec
amendment `A<n>`) · decided (decision `D<n>`) · refuted (with evidence) · not applied (with
the reason). Design-level gaps are resolved by best fit against the codebase and the rest of
the spec and recorded as an amendment naming the alternatives; only a gap with no defensible
best fit becomes a gate for the owner. Every structural spec fix runs the cross-reference
sweep: grep the spec for every concept touched and keep it consistent end to end.

A fixer never lowers the bar to make a finding go away, never marks an architectural issue
fixed by editing the symptom, never skips a finding because it is pre-existing, and never
returns with zero fixes landed unless it is genuinely blocked (stuck report).

## The batch skeptic (Execute)

- **One skeptic per batch of landings or fix rounds, not per landing.** A batch is the tasks
  landed since the last skeptic, or one fixer's whole fix set.
- The skeptic is a fresh opus agent given the goal, the diff and the ledger's test commands,
  prompted to **refute**: run the named tests, read the diff, apply the mutation each test
  claims to catch and confirm it goes red, check the discriminator on every numeric done-when.
  Plant known-false probes among the claims; a skeptic that confirms a probe is not
  reading, and its verdicts are discarded.
- It returns `PASS` or `FINDINGS` with severity, location, evidence and the exact counts it
  saw. It never fixes.
- **Stop signal**: a pass returning only low or latent findings closes the batch with the risk
  written in the ledger. Two such passes in a row means you are past the point of value.
- Two fix rounds per task, then you take the task over yourself. Attempts are counted per
  task in `PROGRESS.md`.
- Attribution before alarm: a red test is attributed (this change, bleed from a sibling, the
  box, inherited) before anyone acts on it. Bisect before blaming.

## Returning

`REVIEW <artifact> — <verdict>, <n> findings (<c> critical / <m> major / <k> minor), fix
ledger at <path>` or `SKEPTIC <batch> — PASS | FINDINGS <n>, counts seen: <tests>`.
