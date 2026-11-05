---
name: validating
description: Prove it works before the owner looks — run the protocol, drive the real surface end to end, gate with gestalt where surfaces changed, publish a proof board with evidence per claim, loop fix and re-verify until every card is judged, and say plainly what remains unverified.
phase: validate
---

# Validating

Automated tests pass while the product is still obviously broken to a human eye, and an
automated judge has signed criteria green that were not. Validation is therefore layered:
the protocol, the real surface, the gestalt gate, the proof board, and the owner last. There
is no user in this phase until the board is ready; nothing here asks.

## Depth by rung

Every rung ends with the final QA board (section 4). What the work touched and risks sets
its size, never whether it exists.

- **R0**: the test that fails without the fix, seen red then green, plus whatever check the
  change implies (a build, a rendered screen, a routed message). Paste the counts. Board:
  the handful of cards that say the fix works where a user meets it.
- **R1**: the brief's checks, run and pasted into `PROGRESS.md`, then the board.
- **R2 and R3**: everything below, sized to the surface. At R3 a coverage pass over a large
  surface is a sweep: haiku or sonnet agents each check a slice against one schema, you
  synthesise and judge.
- **R4**: per phase at phase close, with the per-phase boards the owner judges as the epic
  goes (`boards`). Those stay what they are. Once the whole pipeline is implemented, the
  final QA board (section 4) is a separate step with its own catalogue over the entire
  epic, then the final pass against `S1..Sn` with evidence per criterion before the
  completion promise.

## 1. The protocol

Read the spec's validation protocol and its prerequisites. Run each prerequisite check first;
a missing prerequisite is recorded as a failed step with the env var or CLI it should come
from, the rest of the protocol still runs, and the report is `NEEDS_ATTENTION`. Never
authenticate, mint or substitute a credential. Run each command, capture output and exit
code, judge against the stated success. Fix what fails with minimal targeted changes, up to a
handful of fix-and-rerun cycles; undo a fix that makes things worse; stop early on a circular
regression and report it.

## 2. The real surface

E2E means the real application runs in the real environment: real host, real server, real
window, real bytes on the wire, the real deployment boundary. A component rendered in a
simulator with simulated messages is a unit test wearing a costume, and the polytimbral
gauntlet's critical bug (two note queues, one per binary, silent output when hosted) was
invisible to every test that kept producer and consumer in one process.

- Launch programmatically, wait for readiness by signal or poll (never sleep), drive through
  the real interface, observe real outputs, tear down clean, isolate per test.
- Assert on user-visible behaviour a real user would hit in their first minutes, with at
  least one assertion per scenario that would catch a real regression. "If this passes but
  the feature is broken, what did I miss."
- A dependency is mocked only when running it is genuinely impractical (paid with no free
  tier, proprietary hardware), at the outermost boundary, with recorded real responses.
- Visual checks are dual-path where the project has goldens: pixel diff first, then an LLM
  check with negative probes. Goldens are blessed only from a frame that already passed a
  gestalt judgment, with the judging run recorded; an unjudged golden freezes a defect into
  the baseline.
- All bugs found here are yours to fix, pre-existing or not, with a red-then-green test.

## 3. The gestalt gate

Where the work built or changed a user-visible surface, run a gestalt walk on it with the
gestalt plugin (`/gestalt walk`, or the walk skill's procedure driven by hand): capture the
rendered artifact, read numbers from the structured sidecar never from pixels, judge
closed-world against the charter written at Spec time, sweep every affordance to intent,
hop one entity across every surface that shows it, verify every candidate finding by a second
source or a fresh skeptic with planted probes, restore any state you wrote and prove it.

Gate rules:

- **BLOCK** on any confirmed high finding; any confirmed finding on a surface this work built
  or changed; a built surface with no charter or no capture; a harness integrity failure on a
  surface this work owns; a policy breach or a missing restore verification.
- **ADVANCE** otherwise, recording confirmed findings on untouched surfaces as pre-existing,
  design gaps as owner gates, and charter corrections as cited `benign.md` lines.
- A high the work cannot legitimately fix is deferred only by landing a deterministic oracle
  that pins it (red-verified, registered in the suite CI runs). Deferral costs an oracle;
  dismissal costs a cited benign line. Never silently.
- Three outcomes per check, not two: PASS, FINDING, NOT VERIFIED. Uncovered surface never
  counts as green.

A walk is driven, never built: throwaway scripts in the run directory, no harness.

## 4. The final QA board

A separate step, run once the pipeline is fully implemented, and distinct from any
per-phase board: its own catalogue, over everything the pipeline shipped. Every pipeline
ends with one, whatever its size. The goal is that every card a machine can
prove is proven, and every defect found is fixed and rewalked, before the owner looks. The
owner's clicks then judge a finished product, not a to do list.

### Size it to the task

Size the catalogue to what the work touched and what it risks, never to a target count. There
is no quota: as many cards as the work needs, and no more. A one line change in a payment
path earns more cards than a large refactor of a test helper; a single fix may need a
handful, a release branch hundreds. Decide from the census, not from the rung.

- Scale the method with the count: a small board you prove yourself; a wide one fans out per
  area in waves, with sweeps for mechanical captures and a ledger entry and recount per wave.
- Never pad: every card has its own observable that could fail, and one observable is one
  card. Never trim to save effort: a surface the work changed with no card is a hole in the
  board, and the board says so.
- The page, the tooling and the loop are the same at every size.

### 4.1 Author the catalogue (once everything is implemented, before the e2e)

Not at Spec time: the spec moves during Execute, and a catalogue written then describes a
plan that no longer exists. Not from the per-phase boards: they judged each phase as it
landed, not the whole as it now stands. Not after the e2e: a catalogue written from what already passed
tests the tests. Author it when Execute is done and before the first proof run, from:

- a **census of the real diff**: every commit, every touched file, every changed behaviour,
  including what landed without being planned (that is where the defects hide);
- `S1..Sn`, the charters, the edge cases and the amendments, as they stand now;
- the **previous release as a baseline**: what worked before and must still work (upgrade
  paths, saved data, settings, migrations), not only what is new;
- every surface a user meets: each app, device, page, CLI, email, file format, and each
  boundary between two of them.

Write it adversarially: for each change ask how it could be wrong for a real user in the
first minutes, and write that as a card. Each card states `what`, `where`, a concrete
`check` with the observable that decides it, the `gate` (test, code line or flag), and
`proof`: the evidence the card requires (screenshot of the real surface, rendered audio,
HTTP response, SQL row, device memory read, a named test run). Tier the cards by risk and by
rollout stage. A card that cannot say what would make it fail is not a card yet.

### 4.2 Prove every card yourself

Fan out per area (opus for judgement, sonnet for mechanical captures) with one written
agent brief and one proof contract for all of them (see `boards`). The contract:

- A card passes only on evidence of the real surface or a test run in this session, cited
  by exact case names and the tail of the output. An earlier run, a green CI badge or a
  code reading is not proof.
- The strongest evidence wins: a measurement over a screenshot of a number, a read of the
  device over a claim about it.
- Plain sentences: what was done, what was seen, the counts. No hedging.
- A card that turns out to be wrong about the product (the feature changed by design, the
  check names removed behaviour) is corrected in the catalogue with the reason, never
  passed or failed as written.

**Shrink `human` to what truly needs a person.** Before marking a card human, find a machine
path and record it as the accepted method: drive the app through its accessibility tree,
inject gestures at the device's input seam from a QA build, read the screen or LEDs from
device memory, render and measure the audio, pay a test mode checkout headlessly, seed the
backend with the state the card needs. Human is for taste, feel, a part nobody has on the
bench, and decisions only the owner can take; each human card says which. Out of bench
cards (another OS, other hardware) say so and are counted apart.

### 4.3 Fix and rewalk before the owner looks

Every `fail` is fixed with a red then green test and a mutation check, then the card is
rewalked on the rebuilt surface. Every `partial` names its missing leg, and the loop goes
after the legs. Recount after each wave (`pass / fail / partial / human / blocked` out of
the total) and write the tally in the ledger with the wave's fixes, commits and incidents.
Publish when the machine provable cards are proven or their remaining legs are genuinely out
of reach, and state the ceiling: how many cards need hands, another bench or a decision.

### 4.4 Publish and run the owner rounds

Build and publish the board (`scripts/proof-board.py`, then the Artifact tool with the `db`
capability). Your verdicts are frozen in the page; the owner's go into the database. Then
the rounds: read the owner's verdicts back, fix every `issue` with a red then green test and
a mutation check, redeploy, re-prove the affected cards, republish a new version, back up
the verdicts. Repeat until every card carries an owner verdict. What is left is listed as
open in the handoff, never quietly dropped.

The owner's "does this look right" is a taste call and a gate; your 7 out of 10 is not a
pass.

## 5. The report

`validation.md`: a verdict table (check, method: measured | analytic | not measured, result,
evidence path), the gestalt verdict with its run doc, the board URL and its tally, then a
plain list of what remains unverified. Result: `PASS`, `PARTIAL` or `NEEDS_ATTENTION`.

## Returning

`VALIDATION <result> — protocol <n>/<n>, e2e <n>/<n>, gestalt <ADVANCE|BLOCK|N/A>, board
<url> <tally>, unverified: <list>, report at <path>`.
