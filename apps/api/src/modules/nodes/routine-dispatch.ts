// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A routine tick that runs on a node (S21, S23, D9, A23, A50/F8).
 *
 * The routine worker asks `planRoutineRun` after its scope pre-checks (scope
 * drift, owner ceiling) and before the credit pre-check, because credits
 * gate only a run that happens in the cloud (A57: a node runs on its owner's
 * own Claude sign-in):
 *   - `cloud`: check credits, then invoke the agent as always (runs_on cloud,
 *     or node_else_cloud with no live node: `fellBack`, recorded as a
 *     `fell_back` job by `recordRoutineFallback` only once the credits allow
 *     the cloud run; out of credits it is skipped like any cloud run).
 *   - `node`: write the run row `dispatched` and hand the run to a node job
 *     (`dispatchRoutineToNode`). The job carries the prompt (with the budget
 *     and report sentences), the trigger event as DATA for the node's untrusted-data block
 *     (A22), and the run's token budget and hard limit. Offline, the job
 *     waits and the owner gets a push (createNodeJob). The run row and a
 *     one-shot routine settle when the job ends (`settleRoutineRunForJob`).
 *     The job is a session's run (S17, D27): the owner's config for a
 *     scheduled run, an isolated one for an event-triggered run, with the
 *     routine's folder, repo and model at the agent's profile level. No node
 *     is picked here, so no path is stored and the model is not resolved:
 *     the claim resolves both on the claiming node (K9).
 */
import { levelRow, type NodeLevel } from "@liaison/shared"
import type { routines } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import type { RoutineTriggerEvent } from "~/modules/agent/routines/routine-worker"
import type { RunTokenAccount } from "~/modules/agent/runtime/run-token-limit"
import {
  createNodeJob,
  liveNodeTargets,
  loadNodeProfile,
  type NodeJobRow,
  type NodeJobSessionInput,
  recordFellBackJob,
} from "./jobs"

type RoutineRow = typeof routines.$inferSelect

export type RoutineRunPlan = { where: "cloud"; fellBack: boolean } | { where: "node" }

interface RoutineRunInput {
  routine: RoutineRow
  threadId: string
  prompt: string
  triggerEvent?: RoutineTriggerEvent
  tokenAccount?: RunTokenAccount
}

function jobInput(input: RoutineRunInput, sourceRef: string | null) {
  const { routine } = input
  return {
    orgId: routine.orgId,
    ownerUserId: routine.ownerUserId,
    agentId: routine.ownerAgentId as string,
    threadId: input.threadId,
    source: "routine" as const,
    sourceRef,
    routineId: routine.id,
    prompt: input.prompt,
    trigger: input.triggerEvent ? { event: input.triggerEvent } : null,
    // The routine's owner runs it under their own grants (the pre-checks just
    // proved they hold its scopes); nothing outside them triggered it.
    sourceRequiredScopes: [],
    tokenBudget: input.tokenAccount?.tokenBudget ?? input.routine.tokenBudget ?? null,
    hardTokenLimit: input.tokenAccount?.hardTokenLimit ?? input.routine.hardTokenLimit ?? null,
  }
}

/**
 * Where this tick runs. `node_else_cloud` with no live node answers `cloud`
 * with `fellBack`; the caller records the fallback (`recordRoutineFallback`)
 * only when the cloud run actually goes ahead. A node run needs an owner agent
 * (the job is that agent's): a routine without one runs in the cloud under
 * `node_else_cloud` and fails under `node`.
 */
export async function planRoutineRun(input: { routine: RoutineRow }): Promise<RoutineRunPlan> {
  const { routine } = input
  const runsOn = routine.runsOn ?? "cloud"
  if (runsOn === "cloud") return { where: "cloud", fellBack: false }
  if (!routine.ownerAgentId) {
    if (runsOn === "node_else_cloud") return { where: "cloud", fellBack: false }
    throw new Error("This routine runs on a node but has no owner agent to run there.")
  }
  if (runsOn === "node_else_cloud") {
    const live = await liveNodeTargets(routine.orgId, routine.ownerUserId)
    if (live.length === 0) return { where: "cloud", fellBack: true }
  }
  return { where: "node" }
}

/** `node_else_cloud` found no live node and the run is going to the cloud. */
export async function recordRoutineFallback(input: RoutineRunInput): Promise<NodeJobRow> {
  return recordFellBackJob(jobInput(input, null))
}

/** The session a node routine run is (S17, D27, L26). */
async function routineSession(input: RoutineRunInput): Promise<NodeJobSessionInput> {
  const { routine } = input
  const { level } = await loadNodeProfile(
    routine.orgId,
    routine.ownerUserId,
    routine.ownerAgentId as string,
  )
  return {
    source: "routine",
    configKind: input.triggerEvent ? "isolated" : "owner",
    folderName: routine.folder ?? null,
    repo: routine.repo ?? null,
    model: routine.model ?? "default",
    level: input.triggerEvent ? capEventRunLevel(level) : level,
  }
}

/**
 * An event-started run has outside text in its prompt (the triggering event's data) and no person
 * watching, so it never runs above NODE_EVENT_RUN_MAX_LEVEL (strict by default) whatever the
 * agent's profile says. A scheduled or manual run keeps the profile level.
 */
export function capEventRunLevel(level: NodeLevel): NodeLevel {
  const cap = env.NODE_EVENT_RUN_MAX_LEVEL
  return levelRow(level).rank > levelRow(cap).rank ? cap : level
}

/** Hand the tick to a node job; `runId` is the `dispatched` run row it settles. */
export async function dispatchRoutineToNode(
  input: RoutineRunInput & { runId: string },
): Promise<NodeJobRow> {
  const runsOn = input.routine.runsOn === "node_else_cloud" ? "node_else_cloud" : "node"
  return createNodeJob({
    ...jobInput(input, input.runId),
    runsOn,
    session: await routineSession(input),
  })
}
