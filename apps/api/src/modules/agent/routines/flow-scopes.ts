// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The scopes a routine's flow (0303) needs to run, read from the flow record contract its trigger
 * entity declares (`entities.<e>.routineFlow`, flow-records.ts) and the tool registry:
 *
 * - reading the trigger record (every flow on a record event reads it for its conditions, its
 *   placeholders and its record actions): the entity's `readScope`;
 * - each record action's tool (`updateTool` for assign, set_status and set_field, `commentTool`
 *   for comment): that tool's `requiredScopes`;
 * - a direct message (`kernel:threads_create`): its `requiredScopes`;
 * - a notify step that reaches anyone but the routine's owner: the record's `notifyScope`.
 *
 * A create, an update and a template enable add these to the routine's scopes, so a flow saved
 * through any of them can run; a need its owner does not hold is refused at save, naming the step
 * and the scope (`flowScopeRefusal`). An agent step's own tools come from the routine's listed
 * scopes, as a legacy routine's do.
 */
import type { RoutineFlow } from "@liaison/shared"
import { isScopeCovered } from "~/modules/agent/scopes/scope-coverage"
import { entityRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { flowRecordSource, flowRecordTool } from "./flow-records"

/** One scope a flow needs, and the step that needs it (null: reading the trigger record). */
export interface FlowScopeNeed {
  scope: string
  stepId: string | null
}

function toolScopes(orgId: string, qualified: string): readonly string[] {
  const [app, ...rest] = qualified.split(":")
  const def = toolRegistry.get([orgId, app ?? "", rest.join(":")])
  return def?.requiredScopes ?? []
}

/** The scopes `flow` needs on the routine's trigger `event` (`app:entity:action`), in order. */
export function flowScopeNeeds(
  orgId: string,
  event: string | null | undefined,
  flow: RoutineFlow,
): FlowScopeNeed[] {
  const [app, entity] = (event ?? "").split(":")
  const src = flowRecordSource(orgId, app, entity)
  const needs: FlowScopeNeed[] = []
  const add = (scope: string, stepId: string | null) => {
    if (!needs.some((n) => n.scope === scope)) needs.push({ scope, stepId })
  }
  if (src) {
    const readScope = entityRegistry.get([orgId, src.app, src.entity])?.readScope
    if (readScope) add(readScope, null)
  }
  for (const step of flow.steps) {
    if (step.type !== "action") continue
    if (step.action === "message") {
      for (const s of toolScopes(orgId, "kernel:threads_create")) add(s, step.id)
    } else if (step.action === "notify") {
      const others = step.args.to.some((ref) => ref !== "{{owner}}")
      if (others && src) add(src.decl.notifyScope, step.id)
    } else if (src) {
      const tool = flowRecordTool(src, step.action === "comment" ? "comment" : "update")
      for (const s of toolScopes(orgId, tool)) add(s, step.id)
    }
  }
  return needs
}

/** The needs the owner's `ownerScopes` do not cover. */
export function uncoveredFlowNeeds(
  needs: readonly FlowScopeNeed[],
  ownerScopes: readonly string[],
): FlowScopeNeed[] {
  return needs.filter((n) => !isScopeCovered([n.scope], [...ownerScopes]))
}

/** The save refusal for needs the routine's owner lacks, or null when every need is covered. */
export function flowScopeRefusal(
  missing: readonly FlowScopeNeed[],
): { error: { code: string; message: string } } | null {
  if (missing.length === 0) return null
  const parts = missing.map((n) =>
    n.stepId
      ? `step "${n.stepId}" needs ${n.scope}`
      : `reading the trigger record needs ${n.scope}`,
  )
  return {
    error: {
      code: "flow_scope_missing",
      message: `The routine's owner cannot run this flow: ${parts.join("; ")}. Remove or change those steps, or ask an admin for the scope.`,
    },
  }
}

/** `scopes` with each of `needs` added once, in order. */
export function withFlowScopes(
  scopes: readonly string[],
  needs: readonly FlowScopeNeed[],
): string[] {
  const out = [...new Set(scopes)]
  for (const n of needs) if (!out.includes(n.scope)) out.push(n.scope)
  return out
}
