# Precepts

A development guideline for a strong model. These are the rules that survived a year of
runs on three repos; each one was paid for. They are read once at Frame and re-read when a
report is about to claim something.

## Grounding

- No unverified claim in a spec or plan. An API reference is read, a number carries its
  derivation or source, a compatibility claim cites or is marked assumed.
- Cite or drop: a claim about our tree carries `file:line`; a claim about the world carries a
  source. Record what you could not determine; an open question is worth more than a guess.
- Prior art is for failure modes, not features: what did shipped products get wrong.
- A fact you verified that contradicts the spec is a spec problem. Stop and record it.

## Tests and evidence

- A test counts only if it fails without the fix. Assert real output (audio RMS, routed MIDI,
  device state, rendered artifact), not proxies.
- Every numeric done-when states its discriminator: what must fail when the feature is absent.
- Floors before equalities; a zero-valued counter is never a pass. A fixture that generates
  the stimulus it asserts proves only self-consistency.
- Mutation beats narration: apply the mutation a test claims to catch and watch it go red.
- Never claim a test result you did not see. Paste the actual counts.
- A flaky test is not a fix. A pass on re-run with no code change is recorded as flaky.
- Never dismiss a failing test as pre-existing without attributing it first (bleed, box,
  inherited). Then fix it.
- Screenshots do not reveal defects; numeric checks do. Read numbers from a structured
  sidecar, never from pixels.
- A paraphrased formula is a defect even if tests pass.

## Verification budget

- Verification is a cost centre: budget it, do not maximise it. Review sits well under a
  third of implementation time.
- One skeptic per batch of landings or fix rounds, not per round. A pass returning only low
  or latent findings closes the batch with the risk written down; two such passes in a row
  means you are past the point of value.
- A gate's verdict counts only if the gate has been validated against a certified baseline.
- One whole-surface gate per phase, scoped to the modules touched plus their direct importers,
  started while the next phase begins; never re-run a full gate to re-certify after fixes.
- Timebox a gate at 30 minutes; take partial results and decide CLOSE, DO NOT CLOSE, or
  CLOSE WITH GAPS, naming what went unverified.
- Assume the implementation is wrong until evidence proves otherwise. A done-signal from a
  subagent is evidence, not proof.

## Delegation

- Delegate when it saves context or time, never by rank. Subagents start blank. The top
  level spawns whatever it needs; a subagent spawns nothing, except that an opus implementer
  may spawn a haiku broad sweep. Depth never exceeds two.
- Do it yourself when the files are already in your context, the change is small, writing
  the prompt would be longer than the work, or you already root-caused it.
- Delegate: a broad sweep with a small answer (haiku); implementation in files you have not
  read and will not need afterwards (sonnet only when the spec fully determines the code,
  otherwise opus; a failed sonnet run costs more than one opus run); independent parallel
  work, launched in one message; verification of a finished diff by a fresh opus agent given
  the goal and the diff, pass or fail with evidence; anything over a minute, detached and
  logging to a file.
- Every Agent call names its model explicitly. The orchestrator's own model is never a
  subagent's model. Verifiers and skeptics are opus, never the top-level model. When in doubt
  between tiers, go up one.
- Prompts state the goal, the constraints and the exact shape of the answer. Reports are
  short and never paste files. A subagent never invents a design, widens scope or weakens a
  test; it returns a stuck report (tried, observed, suspected blocker).

## Long-running work

- Any run expected to outlive a minute is detached and logs to a file, never through a
  filter pipe. Arm a stall watchdog at a tenth of the expected duration that fires on stall,
  death and completion. Liveness is artifact evidence (mtimes, log growth, CPU accrual), never
  a report. One blocking wait per ten minutes; no tick-polling.
- Builds and tests run in the foreground with a generous timeout when a Stop hook is armed;
  a backgrounded build plus a Stop hook produces useless wake-ups.
- One build at a time across you and every subagent. Heavy jobs go through the machine-wide
  job-slot semaphore where one exists; a refusal is final.
- Verify the branch in the same command as the commit. Never `git add -A`.
- Every timestamp in a ledger comes from the clock in the same step, never estimated.

## Ledger and autonomy

- The ledger is written before you would need it, never after. Anything that exists only
  in context is one compaction from gone.
- Where the ledger and git disagree, git is the truth; reconcile, then continue.
- After the design is approved there is no human in the loop. Decide with the sensible,
  reversible, convention-matching default and keep driving. Everything only the owner can
  provide (credentials, authenticated CLIs, deploy targets, accounts) is elicited during
  Brainstorm and recorded in the spec's prerequisites, never the secret itself.
- Owner decisions queue in a gate file with an id; never block a task on one that is not
  genuinely blocking. Never write, edit or fabricate a sign-off yourself.
- If something is not working, fix it, including defects in shipped or closed work, with the
  fix measured, the guard that missed it repaired, and the whole thing recorded. Never ask
  which of several found bugs to fix: fix them all.
- Escalate only the genuinely impossible, a product trade only the owner can price, or a
  scope change.

## Gestalt

- A walk is driven, never built. Judge the rendered artifact, never the diff.
- Charters are written before the artifact is judged. Writing the ground truth and grading
  yourself against it is circular.
- Never weaken an oracle to pass a feature; extend its named exception surface with a reason.
- A golden accepts whatever was blessed: bless one only from a frame that passed a judgment,
  and record the run that judged it.

## Replies

- Reply length is a hard budget: under six lines by default, a status update is one to
  three. Lead with the outcome, then only what changes the next decision.
- Do not print the plan, the waiting list, the reasoning or lessons learned: that belongs in
  the ledger or the artifact. Say the new thing and stop.
- The report always states plainly what remains unverified.
- No attribution trailers in commits.
