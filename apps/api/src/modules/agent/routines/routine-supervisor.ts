// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Routine supervisor — drives one logical routine task across N bounded turns.
//
// The per-turn agent budget (A1) caps a single `invokeAgentForThread` turn at
// STEP_LIMIT steps; a task that needs more than one turn's worth of steps
// signals `finishReason === "length"`. The supervisor re-invokes the SAME thread
// while the model keeps reporting `length`, summing the real `turnsAdded`, and
// stops on the first non-`length` finish (natural completion / error). Three
// independent safety bounds prevent a runaway loop: `maxTurns` (a model that
// never says "stop"), `deadlineMs` (a wall-clock bound that MUST stay under the
// 600s routine lock TTL so a long run can't outlive its lock → no double-run /
// double-charge), and a per-turn credit re-check (the within-turn `checkMidStep`
// only guards inside a single turn, not between them).

export interface SupervisorPolicy {
  maxTurns: number
  perTurnBudget: { maxSteps: number; timeoutMs: number }
  /** MUST be ≤ 540_000 — safety margin vs the 600s routine lock TTL. */
  deadlineMs: number
}

export interface SupervisorResult {
  turnsAdded: number
  finalFinishReason: string
  stoppedBy: "completion" | "maxTurns" | "deadline" | "credits"
}

export async function runRoutineSupervisor(args: {
  invokeTurn: (a: { perTurnBudget: { maxSteps: number; timeoutMs: number } }) => Promise<{
    finishReason: string
    turnsAdded?: number
  }>
  policy: SupervisorPolicy
  /** null = funded; a non-null reason string halts the loop between turns. */
  checkCredits: () => Promise<string | null>
  now: () => number
}): Promise<SupervisorResult> {
  const start = args.now()
  let turnsAdded = 0
  let finishReason = "stop"
  for (let turn = 0; turn < args.policy.maxTurns; turn++) {
    if (await args.checkCredits())
      return { turnsAdded, finalFinishReason: finishReason, stoppedBy: "credits" }
    if (args.now() - start >= args.policy.deadlineMs)
      return { turnsAdded, finalFinishReason: finishReason, stoppedBy: "deadline" }
    const r = await args.invokeTurn({ perTurnBudget: args.policy.perTurnBudget })
    turnsAdded += r.turnsAdded ?? 1
    finishReason = r.finishReason
    if (finishReason !== "length")
      return { turnsAdded, finalFinishReason: finishReason, stoppedBy: "completion" }
  }
  return { turnsAdded, finalFinishReason: finishReason, stoppedBy: "maxTurns" }
}
