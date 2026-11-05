// SPDX-License-Identifier: FSL-1.1-ALv2
//
// D18: WHEN AN AGENT SETS UP WORK ON A NODE, IT TELLS THE USER THE RISK. A
// routine created or moved to "My computer" (node, node_else_cloud) answers
// with the level risk note (T01, D20: no hosting provider's settings) for the
// model that will run, and the instruction to relay it before confirming: the
// same one or two sentences Settings > Computers shows beside the agent. The
// model is the routine's node model (`routines.model`, L18) when set, else its
// cloud model, else its agent's preference.
import {
  type NodeGuardrailLevel,
  nodeGuardrailRiskNote,
  suggestedNodeGuardrail,
} from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withRlsContext } from "~/db/rls"
import { agents, routines } from "~/db/schema/kernel"

export const NODE_RISK_NOTE_RELAY =
  "Before you confirm this to the user, tell them this risk note in your own words, and that they can set the guardrail level of this agent in Settings > Computers > Agents."

export interface NodeGuardrailDisclosure {
  riskNote: string
  suggestedGuardrail: NodeGuardrailLevel
  relay: string
}

/** The note for a node-bound piece of work, or null when it runs in the cloud. */
export async function nodeGuardrailDisclosure(input: {
  /** The caller's RLS client: kernel.agents is readable org wide (agents_select).
   *  Absent on the HTTP routes' handler context (handler-rpc buildAppContext); the
   *  read then opens the acting user's own RLS transaction (userId, scopes). */
  db?: RlsClient
  orgId: string
  /** The acting user, for the RLS transaction opened when `db` is absent. */
  userId: string
  scopes?: readonly string[]
  runsOn: string | null | undefined
  /** The routine's node model (`routines.model`, L18): what a node run uses. Wins over all. */
  nodeModelId?: string | null
  /** The routine's own (cloud) model, which wins over its agent's. */
  modelId?: string | null
  agentId?: string | null
}): Promise<NodeGuardrailDisclosure | null> {
  if (input.runsOn !== "node" && input.runsOn !== "node_else_cloud") return null
  let model = input.nodeModelId ?? input.modelId ?? null
  if (!model && input.agentId) {
    const agentId = input.agentId
    const read = (db: Pick<RlsClient, "select">) =>
      db
        .select({ model: agents.modelPreference })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.orgId, input.orgId)))
        .limit(1)
    const [row] = input.db
      ? await read(input.db)
      : await withRlsContext(
          {
            actorType: "user",
            userId: input.userId,
            orgId: input.orgId,
            scopes: [...(input.scopes ?? [])],
            dimensionGrants: {},
          },
          (tx) => read(tx),
        )
    model = row?.model ?? null
  }
  const suggested = suggestedNodeGuardrail(model)
  return {
    riskNote: nodeGuardrailRiskNote(suggested),
    suggestedGuardrail: suggested,
    relay: NODE_RISK_NOTE_RELAY,
  }
}

/** Where a routine runs, as one approval-card line. */
export function routineRunsOnLine(runsOn: string, update = false): string {
  const where =
    runsOn === "node"
      ? "your computer (its node)"
      : runsOn === "node_else_cloud"
        ? "your computer, else the cloud"
        : "the cloud"
  return update ? `runs on → ${where}` : `Runs on: ${where}`
}

/**
 * D18 for a GATED create/update of a routine (walk 2026-10-12, N14): a gated
 * call answers with a pending approval, not the tool result that carries the
 * note, so the agent confirmed a node routine without a word of the risk (and
 * summary lines are capped at 8 x 200 chars, too small for it). Registered as
 * the routine tools' `gatedAgentNotes`: the gate adds what this returns to the
 * pending result the agent reads. Null when the routine stays in the cloud.
 */
export async function gatedRoutineAgentNotes(
  tool: "create_routine" | "update_routine",
  params: unknown,
  ctx: { orgId: string; userId: string; scopes: readonly string[] },
): Promise<{ nodeGuardrails: NodeGuardrailDisclosure } | null> {
  const p = (params ?? {}) as {
    id?: string
    runsOn?: string
    agentModelId?: string | null
    ownerAgentId?: string | null
  }
  if (p.runsOn !== "node" && p.runsOn !== "node_else_cloud") return null
  let modelId = p.agentModelId ?? null
  let nodeModelId: string | null = null
  let agentId = p.ownerAgentId ?? null
  if (tool === "update_routine" && p.id) {
    const routineId = p.id
    // The acting user's own RLS transaction: they are updating this routine, so
    // they can read it (no privileged handle, db-import-enforcement).
    const [row] = await withRlsContext(
      {
        actorType: "user",
        userId: ctx.userId,
        orgId: ctx.orgId,
        scopes: [...ctx.scopes],
        dimensionGrants: {},
      },
      (tx) =>
        tx
          .select({
            model: routines.agentModelId,
            nodeModel: routines.model,
            agentId: routines.ownerAgentId,
          })
          .from(routines)
          .where(and(eq(routines.id, routineId), eq(routines.orgId, ctx.orgId)))
          .limit(1),
    )
    if (p.agentModelId === undefined) modelId = row?.model ?? null
    nodeModelId = row?.nodeModel ?? null
    agentId = agentId ?? row?.agentId ?? null
  }
  const nodeGuardrails = await nodeGuardrailDisclosure({
    orgId: ctx.orgId,
    userId: ctx.userId,
    scopes: ctx.scopes,
    runsOn: p.runsOn,
    nodeModelId,
    modelId,
    agentId,
  })
  return nodeGuardrails ? { nodeGuardrails } : null
}
