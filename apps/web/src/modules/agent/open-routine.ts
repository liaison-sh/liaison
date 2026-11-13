// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Where a routine opens: its owner agent's page, Routines tab, with the routine selected.
 * The project Automations list and the routines list fallback both open it here.
 */
import { openTab } from "~/modules/shell/tab-store"
import { AGENT_PAGE_TAB_TYPE, canonicalAgentPageEntityId } from "~/modules/threads/agent-directory"
import { type RoutineRow, routineLabel } from "./routines-store"

export function openRoutineOnAgentPage(
  r: Pick<RoutineRow, "id" | "name" | "title" | "ownerAgentId">,
): void {
  const agent = canonicalAgentPageEntityId(r.ownerAgentId ?? "self")
  openTab({
    type: AGENT_PAGE_TAB_TYPE,
    entityId: agent,
    label: routineLabel(r),
    routePath: `/agents/${agent}/routines?selected=${encodeURIComponent(r.id)}`,
  })
}
