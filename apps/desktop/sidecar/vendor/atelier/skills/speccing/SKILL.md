---
name: speccing
description: Turn the settled design into the contract and the plan — success criteria, validation protocol, prerequisites, then task-depth planning at the rung's depth, written per phase and never for every phase up front.
phase: spec
---

# Speccing

The spec is read by agents who fill gaps with invention, so every ambiguity is a divergence
discovered later. Write assertions, not aspirations.

## Depth by rung

- **R0**: the done-when lines in `brief.md` are the spec. Nothing else.
- **R1**: a short brief in `brief.md`: what changes, the criteria, the checks to run, the
  files. It is the plan too.
- **R2 and R3**: `spec.md` plus `plan.md`.
- **R4**: `spec.md` with satellites split by facet only when a facet would drown the core
  (`spec-<facet>.md`), `decisions.md` (append-only `D<n>`), `design-constraints.md` (owner
  constraints verbatim), `roadmap.md`, and one `plans/P<n>-<slug>.md` per phase written when
  that phase starts.

## The spec

- **Numbered success criteria `S1..Sn`**, each independently checkable by an agent. A
  criterion no agent can evaluate is a wish.
- **Definitions** for every term with a project-specific meaning.
- **Budgets as numbers** with the measurement method: not "fast" but "≥1× real time measured
  by X on profile Y".
- **Components and data flow**: responsibility, data in with its exact source, data out with
  its destination, failure mode to response, boundary conditions.
- **Cross-boundary protocols** where two systems talk: typed messages, direction, error
  signalling, behaviour when one side is unavailable.
- **Integration**: which entry points change so the feature is reachable. Unwired is unbuilt.
- **Edge cases enumerated** with the intended behaviour. An unlisted edge case gets invented.
- **Fallbacks pre-designed** for every risky mechanism.
- **Validation protocol**: the literal commands, copy-pasteable, with what success looks like
  and how to read a failure. `N/A` with a reason when nothing executable exists.
- **Prerequisites**: from Brainstorm, never the secret itself.
- **Charters for new user-visible surfaces** (R2 with UI and above): what belongs, what must
  never appear, semantic rules with an explicit "is a finding" clause, cross-references. They
  are written here, before the surface exists, so the gestalt gate has a standard that is not
  circular. Store them under the repo's `gestalt/charters/` when a gestalt workspace exists.
- **Out of scope**, with the reason.
- Mark anything unresolved **OPEN** with who resolves it and when. Cross-reference by stable
  id (`S4`, `D12`), never by section number.

## Amendments

The spec changes by amendment, never by silent edit: a permanent `## Amendments` section, one
line per finding, resolution or deviation, waivers included with their reason. Deviations
found during Execute are batched into one amendment at phase close.

## The plan

A task is a subagent-sized unit that lands in one commit with its own tests. The plan is
written for a strong implementer: it makes the decisions the implementer must not make and
leaves the rest, with the stuck-report rule (a contradiction between plan and tree stops the
task and comes back, it is never improvised around).

Each task carries:

- **What**: one sentence, the outcome.
- **How**: the approach concretely, names, signatures, call sites, data shapes, the patterns
  to follow with `file:line`, what to reuse, the seams it wires into. Not the code.
- **Files it may touch**: an explicit allowlist; an out-of-scope edit is a coordination note.
- **Tests first**: the test names and what each asserts, with its discriminator (what must
  fail when the feature is absent). Observable behaviour, never internals; falsifiable, never
  `toBeDefined`; mocks only at boundaries.
- **Done when**: mechanically checkable.
- **Depends on**: task ids.
- State the negative where it matters: what this task must not change.

Order dependencies first, wiring last; the final task wires the feature in. Group by module.
Every plan ends with the phase's e2e scenario against the real application and the literal
validation commands. At R2 the plan reads like a wave spec: a TDD checklist, verify commands,
commit per repo, do not push.

## Roadmap and per-phase plans (R4)

`roadmap.md`: per phase, what it proves, what gets built, what does not and which phase
picks it up, dependencies, validation, the files it owns, the files frozen to it, the
append-only shared registries. The union of ownerships does not overlap. Phases are
sequential with validation gates. The roadmap is the durable contract.

`plans/P<n>-<slug>.md` is written when phase n starts, by you, grounded against the tree at
that commit (state the commit), reusing task shapes and tests from any earlier plan whose
subject survived. Before writing it, hoist verified integration facts into
`plans/grounding-facts.md` (`file:line`, stamped with tree and date; GAP, HARD BLOCKER and
CAVEAT tagged; registration checklists for anything wired in more than one place). A fact that
contradicts the spec is a hard blocker recorded here, not designed around.

## Returning

Write the files, then: `SPEC WRITTEN — spec.md (S1..S<n>), plan <n> tasks, <n> OPEN,
prerequisites: <list>`; or `PLAN WRITTEN — P<n> <slug>, <n> tasks against <commit>`.
